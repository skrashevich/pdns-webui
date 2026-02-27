package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"runtime/debug"
	"strings"
	"syscall"
	"time"
)

type pdnsConfig struct {
	URL      string
	Key      string
	ServerID string
}

var allowedProxyMethods = map[string]bool{
	http.MethodGet:    true,
	http.MethodPost:   true,
	http.MethodPut:    true,
	http.MethodPatch:  true,
	http.MethodDelete: true,
}

var uiVersion = detectUIVersion()

func main() {
	loadDotEnv(".env")

	indexTemplate, err := template.ParseFiles("templates/index.html")
	if err != nil {
		log.Fatalf("failed to parse template: %v", err)
	}

	client := &http.Client{Timeout: 30 * time.Second}

	mux := http.NewServeMux()
	mux.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.Dir("static"))))
	mux.HandleFunc("/api/config", handleAPIConfig)
	mux.HandleFunc("/api/pdns", handlePDNSProxy(client))
	mux.HandleFunc("/api/pdns/", handlePDNSProxy(client))
	mux.HandleFunc("/", handleIndex(indexTemplate))

	port := getEnv("PORT", "8080")
	addr := "0.0.0.0:" + port

	log.Printf("PowerDNS Web UI listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("server error: %v", err)
	}
}

func handleIndex(indexTemplate *template.Template) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}

		if err := indexTemplate.Execute(w, nil); err != nil {
			log.Printf("failed to render template: %v", err)
			writeError(w, http.StatusInternalServerError, "template render error")
			return
		}
	}
}

func handleAPIConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	cfg := getPDNSConfig()
	writeJSON(w, http.StatusOK, map[string]string{
		"server_id":  cfg.ServerID,
		"ui_version": uiVersion,
	})
}

func detectUIVersion() string {
	buildInfo, ok := debug.ReadBuildInfo()
	if !ok {
		return "dev"
	}

	if buildInfo.Main.Version != "" && buildInfo.Main.Version != "(devel)" {
		return buildInfo.Main.Version
	}

	revision := ""
	modified := ""
	for _, setting := range buildInfo.Settings {
		switch setting.Key {
		case "vcs.revision":
			revision = setting.Value
		case "vcs.modified":
			modified = setting.Value
		}
	}

	if revision == "" {
		return "dev"
	}

	shortRevision := revision
	if len(shortRevision) > 7 {
		shortRevision = shortRevision[:7]
	}

	if modified == "true" {
		return shortRevision + "-dirty"
	}

	return shortRevision
}

func handlePDNSProxy(client *http.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !allowedProxyMethods[r.Method] {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}

		cfg := getPDNSConfig()

		path := strings.TrimPrefix(r.URL.EscapedPath(), "/api/pdns/")
		if path == r.URL.EscapedPath() {
			path = ""
		}
		if path == "" {
			http.NotFound(w, r)
			return
		}

		targetURL := fmt.Sprintf("%s/api/v1/%s", cfg.URL, path)
		if r.URL.RawQuery != "" {
			targetURL += "?" + r.URL.RawQuery
		}

		body, err := io.ReadAll(r.Body)
		if err != nil {
			writeError(w, http.StatusBadRequest, "failed to read request body")
			return
		}

		req, err := http.NewRequestWithContext(r.Context(), r.Method, targetURL, bytes.NewReader(body))
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}

		req.Header.Set("X-API-Key", cfg.Key)
		req.Header.Set("Accept", "application/json")
		if len(body) > 0 {
			req.Header.Set("Content-Type", "application/json")
		}

		log.Printf("%s %s", r.Method, targetURL)

		resp, err := client.Do(req)
		if err != nil {
			status, message := mapProxyError(err, cfg)
			writeError(w, status, message)
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode == http.StatusNoContent {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		respBody, err := io.ReadAll(resp.Body)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}

		contentType := strings.ToLower(resp.Header.Get("Content-Type"))
		if strings.Contains(contentType, "application/json") {
			var payload any
			if err := json.Unmarshal(respBody, &payload); err == nil {
				writeJSON(w, resp.StatusCode, payload)
				return
			}
		}

		writeJSON(w, resp.StatusCode, map[string]string{
			"result": string(respBody),
		})
	}
}

func mapProxyError(err error, cfg pdnsConfig) (status int, message string) {
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return http.StatusGatewayTimeout, "PowerDNS API request timed out"
	}

	if errors.Is(err, context.DeadlineExceeded) {
		return http.StatusGatewayTimeout, "PowerDNS API request timed out"
	}

	if isConnectError(err) {
		return http.StatusServiceUnavailable, fmt.Sprintf("Cannot connect to PowerDNS API at %s: %v", cfg.URL, err)
	}

	log.Printf("unexpected proxy error: %v", err)
	return http.StatusInternalServerError, err.Error()
}

func isConnectError(err error) bool {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return isConnectError(urlErr.Err)
	}

	var opErr *net.OpError
	if errors.As(err, &opErr) && opErr.Op == "dial" {
		return true
	}

	return errors.Is(err, syscall.ECONNREFUSED) ||
		errors.Is(err, syscall.ENETUNREACH) ||
		errors.Is(err, syscall.EHOSTUNREACH)
}

func getPDNSConfig() pdnsConfig {
	return pdnsConfig{
		URL:      strings.TrimRight(getEnv("PDNS_API_URL", "http://localhost:8081"), "/"),
		Key:      getEnv("PDNS_API_KEY", "changeme"),
		ServerID: getEnv("PDNS_SERVER_ID", "localhost"),
	}
}

func getEnv(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func writeError(w http.ResponseWriter, status int, detail string) {
	writeJSON(w, status, map[string]string{"detail": detail})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("failed to write json response: %v", err)
	}
}

func loadDotEnv(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}

	lines := strings.Split(string(data), "\n")
	for _, rawLine := range lines {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		if strings.HasPrefix(line, "export ") {
			line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		}

		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}

		key := strings.TrimSpace(parts[0])
		if key == "" {
			continue
		}
		if _, exists := os.LookupEnv(key); exists {
			continue
		}

		value := strings.TrimSpace(parts[1])
		if len(value) >= 2 {
			if (value[0] == '"' && value[len(value)-1] == '"') ||
				(value[0] == '\'' && value[len(value)-1] == '\'') {
				value = value[1 : len(value)-1]
			}
		}

		if err := os.Setenv(key, value); err != nil {
			log.Printf("failed to set env var %s: %v", key, err)
		}
	}
}
