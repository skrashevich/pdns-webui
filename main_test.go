package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"html/template"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"
)

const (
	// Значения по умолчанию для live интеграционных тестов.
	livePDNSURLDefault = "https://powerdns.wiremockapi.cloud/"
	livePDNSKeyDefault = "123"
)

// newProxyClient возвращает http.Client с разумным таймаутом для тестов.
func newProxyClient() *http.Client {
	return &http.Client{Timeout: 15 * time.Second}
}

// proxyHandler создаёт обработчик прокси с клиентом по умолчанию.
func proxyHandler() http.HandlerFunc {
	return handlePDNSProxy(newProxyClient())
}

// ─── loadDotEnv ───────────────────────────────────────────────────────────────

func TestLoadDotEnv_ParsesBasicVars(t *testing.T) {
	f := writeTempEnv(t, "FOO=bar\nBAZ=qux\n")
	os.Unsetenv("FOO")
	os.Unsetenv("BAZ")
	t.Cleanup(func() { os.Unsetenv("FOO"); os.Unsetenv("BAZ") })

	loadDotEnv(f)

	assertEnv(t, "FOO", "bar")
	assertEnv(t, "BAZ", "qux")
}

func TestLoadDotEnv_SkipsExistingVars(t *testing.T) {
	f := writeTempEnv(t, "EXISTING=new_value\n")
	t.Setenv("EXISTING", "original")

	loadDotEnv(f)

	assertEnv(t, "EXISTING", "original")
}

func TestLoadDotEnv_StripsDoubleQuotes(t *testing.T) {
	f := writeTempEnv(t, `DQUOTED="hello world"`+"\n")
	os.Unsetenv("DQUOTED")
	t.Cleanup(func() { os.Unsetenv("DQUOTED") })

	loadDotEnv(f)
	assertEnv(t, "DQUOTED", "hello world")
}

func TestLoadDotEnv_StripsSingleQuotes(t *testing.T) {
	f := writeTempEnv(t, "SQUOTED='bye world'\n")
	os.Unsetenv("SQUOTED")
	t.Cleanup(func() { os.Unsetenv("SQUOTED") })

	loadDotEnv(f)
	assertEnv(t, "SQUOTED", "bye world")
}

func TestLoadDotEnv_SkipsCommentsAndBlankLines(t *testing.T) {
	f := writeTempEnv(t, "# comment\n\nVALID_VAR=yes\n")
	os.Unsetenv("VALID_VAR")
	t.Cleanup(func() { os.Unsetenv("VALID_VAR") })

	loadDotEnv(f)
	assertEnv(t, "VALID_VAR", "yes")
}

func TestLoadDotEnv_HandlesExportKeyword(t *testing.T) {
	f := writeTempEnv(t, "export EXPORTED_VAR=exported_value\n")
	os.Unsetenv("EXPORTED_VAR")
	t.Cleanup(func() { os.Unsetenv("EXPORTED_VAR") })

	loadDotEnv(f)
	assertEnv(t, "EXPORTED_VAR", "exported_value")
}

func TestLoadDotEnv_MissingFile(t *testing.T) {
	// Не должно паниковать или возвращать ошибку.
	loadDotEnv("/nonexistent/.env.test")
}

// ─── getEnv ───────────────────────────────────────────────────────────────────

func TestGetEnv_ReturnsEnvValue(t *testing.T) {
	t.Setenv("TEST_ENV_KEY", "test_val")
	if got := getEnv("TEST_ENV_KEY", "fallback"); got != "test_val" {
		t.Errorf("got %q, want %q", got, "test_val")
	}
}

func TestGetEnv_ReturnsFallbackWhenMissing(t *testing.T) {
	os.Unsetenv("MISSING_KEY_XYZ")
	if got := getEnv("MISSING_KEY_XYZ", "default"); got != "default" {
		t.Errorf("got %q, want %q", got, "default")
	}
}

func TestGetEnv_TrimsSpaces(t *testing.T) {
	t.Setenv("SPACED_KEY", "  trimmed  ")
	if got := getEnv("SPACED_KEY", "fallback"); got != "trimmed" {
		t.Errorf("got %q, want %q", got, "trimmed")
	}
}

func TestGetEnv_EmptyValueReturnsFallback(t *testing.T) {
	t.Setenv("EMPTY_KEY", "")
	if got := getEnv("EMPTY_KEY", "default"); got != "default" {
		t.Errorf("got %q, want %q", got, "default")
	}
}

// ─── parseListenConfig ───────────────────────────────────────────────────────

func TestParseListenConfig_DefaultsFromEnv(t *testing.T) {
	t.Setenv("HOST", "127.0.0.1")
	t.Setenv("PORT", "9090")

	cfg, err := parseListenConfig(nil, io.Discard)
	if err != nil {
		t.Fatalf("parseListenConfig returned error: %v", err)
	}

	if cfg.Host != "127.0.0.1" {
		t.Errorf("Host = %q, want %q", cfg.Host, "127.0.0.1")
	}
	if cfg.Port != "9090" {
		t.Errorf("Port = %q, want %q", cfg.Port, "9090")
	}
}

func TestParseListenConfig_UsesFallbackDefaults(t *testing.T) {
	t.Setenv("HOST", "")
	t.Setenv("PORT", "")

	cfg, err := parseListenConfig(nil, io.Discard)
	if err != nil {
		t.Fatalf("parseListenConfig returned error: %v", err)
	}

	if cfg.Host != "0.0.0.0" {
		t.Errorf("Host = %q, want %q", cfg.Host, "0.0.0.0")
	}
	if cfg.Port != "8080" {
		t.Errorf("Port = %q, want %q", cfg.Port, "8080")
	}
}

func TestParseListenConfig_FlagsOverrideEnv(t *testing.T) {
	t.Setenv("HOST", "127.0.0.1")
	t.Setenv("PORT", "9090")

	cfg, err := parseListenConfig([]string{"-host", "0.0.0.0", "-port", "8181"}, io.Discard)
	if err != nil {
		t.Fatalf("parseListenConfig returned error: %v", err)
	}

	if cfg.Host != "0.0.0.0" {
		t.Errorf("Host = %q, want %q", cfg.Host, "0.0.0.0")
	}
	if cfg.Port != "8181" {
		t.Errorf("Port = %q, want %q", cfg.Port, "8181")
	}
}

func TestParseListenConfig_Help(t *testing.T) {
	var out bytes.Buffer

	_, err := parseListenConfig([]string{"-h"}, &out)
	if !errors.Is(err, flag.ErrHelp) {
		t.Fatalf("error = %v, want %v", err, flag.ErrHelp)
	}

	help := out.String()
	if !strings.Contains(help, "Usage:") {
		t.Errorf("help output does not contain Usage header: %q", help)
	}
	if !strings.Contains(help, "-host") {
		t.Errorf("help output does not contain -host flag: %q", help)
	}
	if !strings.Contains(help, "-port") {
		t.Errorf("help output does not contain -port flag: %q", help)
	}
}

// ─── getPDNSConfig ────────────────────────────────────────────────────────────

func TestGetPDNSConfig_Defaults(t *testing.T) {
	os.Unsetenv("PDNS_API_URL")
	os.Unsetenv("PDNS_API_KEY")
	os.Unsetenv("PDNS_SERVER_ID")

	cfg := getPDNSConfig()

	if cfg.URL != "http://localhost:8081" {
		t.Errorf("URL = %q, want %q", cfg.URL, "http://localhost:8081")
	}
	if cfg.Key != "changeme" {
		t.Errorf("Key = %q, want %q", cfg.Key, "changeme")
	}
	if cfg.ServerID != "localhost" {
		t.Errorf("ServerID = %q, want %q", cfg.ServerID, "localhost")
	}
}

func TestGetPDNSConfig_TrimsTrailingSlash(t *testing.T) {
	t.Setenv("PDNS_API_URL", "http://pdns.example.com:8081/")

	cfg := getPDNSConfig()
	if strings.HasSuffix(cfg.URL, "/") {
		t.Errorf("URL %q should not have trailing slash", cfg.URL)
	}
}

// ─── detectUIVersion ─────────────────────────────────────────────────────────

func TestDetectUIVersion_ReturnsNonEmptyString(t *testing.T) {
	v := detectUIVersion()
	if v == "" {
		t.Error("detectUIVersion returned empty string")
	}
}

// ─── handleAPIConfig ─────────────────────────────────────────────────────────

func TestHandleAPIConfig_GET_ReturnsServerIDAndVersion(t *testing.T) {
	t.Setenv("PDNS_SERVER_ID", "test-server")

	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	w := httptest.NewRecorder()
	handleAPIConfig(w, req)

	resp := w.Result()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusOK)
	}

	var body map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body["server_id"] != "test-server" {
		t.Errorf("server_id = %q, want %q", body["server_id"], "test-server")
	}
	if _, ok := body["ui_version"]; !ok {
		t.Error("ui_version field missing from response")
	}
}

func TestHandleAPIConfig_GET_ContentTypeIsJSON(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	w := httptest.NewRecorder()
	handleAPIConfig(w, req)

	ct := w.Result().Header.Get("Content-Type")
	if !strings.Contains(ct, "application/json") {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
}

func TestHandleAPIConfig_MethodNotAllowed(t *testing.T) {
	for _, method := range []string{
		http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch,
	} {
		t.Run(method, func(t *testing.T) {
			req := httptest.NewRequest(method, "/api/config", nil)
			w := httptest.NewRecorder()
			handleAPIConfig(w, req)

			if w.Code != http.StatusMethodNotAllowed {
				t.Errorf("status = %d, want %d", w.Code, http.StatusMethodNotAllowed)
			}
		})
	}
}

// ─── handleIndex ─────────────────────────────────────────────────────────────

func TestHandleIndex_Root_Returns200WithHTML(t *testing.T) {
	tmpl := mustParseTemplate(t)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	w := httptest.NewRecorder()
	handleIndex(tmpl)(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", w.Code, http.StatusOK)
	}
	if !strings.Contains(w.Body.String(), "PowerDNS") {
		t.Error("response body does not contain 'PowerDNS'")
	}
}

func TestHandleIndex_NonRootPath_Returns404(t *testing.T) {
	tmpl := mustParseTemplate(t)

	for _, path := range []string{"/other", "/api", "/favicon.ico"} {
		t.Run(path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			w := httptest.NewRecorder()
			handleIndex(tmpl)(w, req)

			if w.Code != http.StatusNotFound {
				t.Errorf("path %s: status = %d, want %d", path, w.Code, http.StatusNotFound)
			}
		})
	}
}

// ─── staticFS ────────────────────────────────────────────────────────────────

func TestStaticFS_CSSFileExists(t *testing.T) {
	staticFS, err := fs.Sub(uiFS, "static")
	if err != nil {
		t.Fatalf("fs.Sub: %v", err)
	}
	if _, err := staticFS.Open("css/style.css"); err != nil {
		t.Errorf("static/css/style.css not found: %v", err)
	}
}

func TestStaticFS_JSFileExists(t *testing.T) {
	staticFS, err := fs.Sub(uiFS, "static")
	if err != nil {
		t.Fatalf("fs.Sub: %v", err)
	}
	if _, err := staticFS.Open("js/app.js"); err != nil {
		t.Errorf("static/js/app.js not found: %v", err)
	}
}

// ─── handlePDNSProxy — изолированные тесты ────────────────────────────────────

func TestHandlePDNSProxy_EmptyPath_Returns404(t *testing.T) {
	t.Setenv("PDNS_API_URL", livePDNSURLDefault)

	req := httptest.NewRequest(http.MethodGet, "/api/pdns", nil)
	w := httptest.NewRecorder()
	proxyHandler()(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want %d", w.Code, http.StatusNotFound)
	}
}

func TestHandlePDNSProxy_TrailingSlashOnly_Returns404(t *testing.T) {
	t.Setenv("PDNS_API_URL", livePDNSURLDefault)

	req := httptest.NewRequest(http.MethodGet, "/api/pdns/", nil)
	w := httptest.NewRecorder()
	proxyHandler()(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want %d", w.Code, http.StatusNotFound)
	}
}

func TestHandlePDNSProxy_DisallowedMethods_Return405(t *testing.T) {
	t.Setenv("PDNS_API_URL", livePDNSURLDefault)

	for _, method := range []string{
		http.MethodHead, http.MethodOptions, http.MethodTrace, http.MethodConnect,
	} {
		t.Run(method, func(t *testing.T) {
			req := httptest.NewRequest(method, "/api/pdns/servers", nil)
			w := httptest.NewRecorder()
			proxyHandler()(w, req)

			if w.Code != http.StatusMethodNotAllowed {
				t.Errorf("method %s: status = %d, want %d", method, w.Code, http.StatusMethodNotAllowed)
			}
		})
	}
}

func TestHandlePDNSProxy_BackendUnreachable_Returns503(t *testing.T) {
	t.Setenv("PDNS_API_URL", "http://127.0.0.1:1")

	req := httptest.NewRequest(http.MethodGet, "/api/pdns/servers", nil)
	w := httptest.NewRecorder()
	handlePDNSProxy(&http.Client{Timeout: 3 * time.Second})(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want %d", w.Code, http.StatusServiceUnavailable)
	}
	var body map[string]string
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body["detail"] == "" {
		t.Error("detail field missing in error response")
	}
}

func TestHandlePDNSProxy_BackendTimeout_Returns504(t *testing.T) {
	hung := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(10 * time.Second)
	}))
	defer hung.Close()

	t.Setenv("PDNS_API_URL", hung.URL)

	req := httptest.NewRequest(http.MethodGet, "/api/pdns/servers", nil)
	w := httptest.NewRecorder()
	handlePDNSProxy(&http.Client{Timeout: 100 * time.Millisecond})(w, req)

	if w.Code != http.StatusGatewayTimeout {
		t.Errorf("status = %d, want %d", w.Code, http.StatusGatewayTimeout)
	}
}

func TestHandlePDNSProxy_NoContent_Returns204(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer backend.Close()

	t.Setenv("PDNS_API_URL", backend.URL)

	req := httptest.NewRequest(http.MethodDelete, "/api/pdns/servers/localhost/zones/test.", nil)
	w := httptest.NewRecorder()
	proxyHandler()(w, req)

	if w.Code != http.StatusNoContent {
		t.Errorf("status = %d, want %d", w.Code, http.StatusNoContent)
	}
}

func TestHandlePDNSProxy_ForwardsAPIKey(t *testing.T) {
	var receivedKey string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedKey = r.Header.Get("X-API-Key")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`[]`))
	}))
	defer backend.Close()

	t.Setenv("PDNS_API_URL", backend.URL)
	t.Setenv("PDNS_API_KEY", "my-secret-key")

	req := httptest.NewRequest(http.MethodGet, "/api/pdns/servers", nil)
	w := httptest.NewRecorder()
	proxyHandler()(w, req)

	if receivedKey != "my-secret-key" {
		t.Errorf("X-API-Key = %q, want %q", receivedKey, "my-secret-key")
	}
}

func TestHandlePDNSProxy_ForwardsQueryString(t *testing.T) {
	var receivedRawQuery string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedRawQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`[]`))
	}))
	defer backend.Close()

	t.Setenv("PDNS_API_URL", backend.URL)

	req := httptest.NewRequest(http.MethodGet, "/api/pdns/servers?rrsets=false", nil)
	w := httptest.NewRecorder()
	proxyHandler()(w, req)

	if receivedRawQuery != "rrsets=false" {
		t.Errorf("query = %q, want %q", receivedRawQuery, "rrsets=false")
	}
}

func TestHandlePDNSProxy_ResponseContentTypeIsJSON(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer backend.Close()

	t.Setenv("PDNS_API_URL", backend.URL)

	req := httptest.NewRequest(http.MethodGet, "/api/pdns/servers", nil)
	w := httptest.NewRecorder()
	proxyHandler()(w, req)

	ct := w.Result().Header.Get("Content-Type")
	if !strings.Contains(ct, "application/json") {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
}

func TestHandlePDNSProxy_NonJSONBackend_WrapsInResult(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("plain text"))
	}))
	defer backend.Close()

	t.Setenv("PDNS_API_URL", backend.URL)

	req := httptest.NewRequest(http.MethodGet, "/api/pdns/servers", nil)
	w := httptest.NewRecorder()
	proxyHandler()(w, req)

	var body map[string]string
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body["result"] != "plain text" {
		t.Errorf("result = %q, want %q", body["result"], "plain text")
	}
}

// ─── handlePDNSProxy — live интеграционные тесты (только безопасные GET) ─────

func TestLivePDNS_GetServers_ProxyMatchesDirect(t *testing.T) {
	assertLiveGETProxyMatchesDirect(t, "servers")
}

func TestLivePDNS_GetServerByID_ProxyMatchesDirect(t *testing.T) {
	assertLiveGETProxyMatchesDirect(t, "servers/"+livePDNSServerID())
}

func TestLivePDNS_GetZones_ProxyMatchesDirect(t *testing.T) {
	assertLiveGETProxyMatchesDirect(t, "servers/"+livePDNSServerID()+"/zones")
}

// ─── mapProxyError ────────────────────────────────────────────────────────────

func TestMapProxyError_DeadlineExceeded_Returns504(t *testing.T) {
	cfg := pdnsConfig{URL: "http://example.com"}
	status, msg := mapProxyError(context.DeadlineExceeded, cfg)

	if status != http.StatusGatewayTimeout {
		t.Errorf("status = %d, want %d", status, http.StatusGatewayTimeout)
	}
	if msg == "" {
		t.Error("expected non-empty error message")
	}
}

func TestMapProxyError_NetTimeout_Returns504(t *testing.T) {
	cfg := pdnsConfig{URL: "http://example.com"}
	err := &url.Error{Op: "Get", URL: "http://example.com/", Err: fakeTimeoutError{}}

	status, _ := mapProxyError(err, cfg)
	if status != http.StatusGatewayTimeout {
		t.Errorf("status = %d, want %d", status, http.StatusGatewayTimeout)
	}
}

func TestMapProxyError_ConnectRefused_Returns503(t *testing.T) {
	cfg := pdnsConfig{URL: "http://127.0.0.1:1"}
	err := &url.Error{
		Op:  "Get",
		URL: "http://127.0.0.1:1/",
		Err: &net.OpError{Op: "dial", Err: syscall.ECONNREFUSED},
	}

	status, msg := mapProxyError(err, cfg)
	if status != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want %d", status, http.StatusServiceUnavailable)
	}
	if !strings.Contains(msg, "Cannot connect") {
		t.Errorf("message %q does not contain 'Cannot connect'", msg)
	}
}

func TestMapProxyError_ConnectRefused_MentionsURL(t *testing.T) {
	cfg := pdnsConfig{URL: "http://192.0.2.1:8081"}
	err := &url.Error{
		Op:  "Get",
		URL: "http://192.0.2.1:8081/api/v1/servers",
		Err: &net.OpError{Op: "dial", Err: syscall.ECONNREFUSED},
	}

	_, msg := mapProxyError(err, cfg)
	if !strings.Contains(msg, cfg.URL) {
		t.Errorf("message %q does not mention URL %q", msg, cfg.URL)
	}
}

// ─── isConnectError ───────────────────────────────────────────────────────────

func TestIsConnectError_DialOpError_True(t *testing.T) {
	err := &net.OpError{Op: "dial", Err: syscall.ECONNREFUSED}
	if !isConnectError(err) {
		t.Error("expected true for dial OpError")
	}
}

func TestIsConnectError_WrappedInURLError_True(t *testing.T) {
	inner := &net.OpError{Op: "dial", Err: syscall.ECONNREFUSED}
	err := &url.Error{Op: "Get", URL: "http://example.com", Err: inner}
	if !isConnectError(err) {
		t.Error("expected true for url.Error wrapping dial OpError")
	}
}

func TestIsConnectError_ECONNREFUSED_True(t *testing.T) {
	if !isConnectError(syscall.ECONNREFUSED) {
		t.Error("expected true for ECONNREFUSED")
	}
}

func TestIsConnectError_ENETUNREACH_True(t *testing.T) {
	if !isConnectError(syscall.ENETUNREACH) {
		t.Error("expected true for ENETUNREACH")
	}
}

func TestIsConnectError_ReadOpError_False(t *testing.T) {
	err := &net.OpError{Op: "read", Err: syscall.ECONNRESET}
	if isConnectError(err) {
		t.Error("expected false for non-dial OpError")
	}
}

func TestIsConnectError_DeadlineExceeded_False(t *testing.T) {
	if isConnectError(context.DeadlineExceeded) {
		t.Error("expected false for DeadlineExceeded")
	}
}

// ─── helpers ──────────────────────────────────────────────────────────────────

func livePDNSURL() string {
	if v := strings.TrimSpace(os.Getenv("TEST_PDNS_API_URL")); v != "" {
		return strings.TrimRight(v, "/")
	}
	return strings.TrimRight(livePDNSURLDefault, "/")
}

func livePDNSKey() string {
	if v := strings.TrimSpace(os.Getenv("TEST_PDNS_API_KEY")); v != "" {
		return v
	}
	return livePDNSKeyDefault
}

func livePDNSServerID() string {
	if v := strings.TrimSpace(os.Getenv("TEST_PDNS_SERVER_ID")); v != "" {
		return v
	}
	if v := strings.TrimSpace(os.Getenv("PDNS_SERVER_ID")); v != "" {
		return v
	}
	return "localhost"
}

func assertLiveGETProxyMatchesDirect(t *testing.T, path string) {
	t.Helper()

	t.Setenv("PDNS_API_URL", livePDNSURL())
	t.Setenv("PDNS_API_KEY", livePDNSKey())
	t.Setenv("PDNS_SERVER_ID", livePDNSServerID())

	client := newProxyClient()
	directURL := livePDNSURL() + "/api/v1/" + path
	directReq, err := http.NewRequest(http.MethodGet, directURL, nil)
	if err != nil {
		t.Fatalf("create direct request: %v", err)
	}
	directReq.Header.Set("X-API-Key", livePDNSKey())
	directReq.Header.Set("Accept", "application/json")

	directResp, err := client.Do(directReq)
	if err != nil {
		t.Skipf("live PDNS is unreachable (%s): %v", livePDNSURL(), err)
	}
	defer directResp.Body.Close()

	directBody, err := io.ReadAll(directResp.Body)
	if err != nil {
		t.Fatalf("read direct body: %v", err)
	}
	directContentType := directResp.Header.Get("Content-Type")

	proxyReq := httptest.NewRequest(http.MethodGet, "/api/pdns/"+path, nil)
	proxyW := httptest.NewRecorder()
	handlePDNSProxy(client)(proxyW, proxyReq)

	if proxyW.Code != directResp.StatusCode {
		t.Fatalf("status mismatch: proxy=%d direct=%d", proxyW.Code, directResp.StatusCode)
	}

	if proxyW.Code == http.StatusNoContent {
		if proxyW.Body.Len() != 0 {
			t.Fatalf("expected empty proxy body for 204, got %q", proxyW.Body.String())
		}
		return
	}

	if !strings.Contains(strings.ToLower(proxyW.Result().Header.Get("Content-Type")), "application/json") {
		t.Fatalf("proxy content-type must be application/json, got %q", proxyW.Result().Header.Get("Content-Type"))
	}

	assertBodyMatchesProxyContract(t, proxyW.Body.Bytes(), directBody, directContentType)
}

func assertBodyMatchesProxyContract(t *testing.T, proxyBody, upstreamBody []byte, upstreamContentType string) {
	t.Helper()

	if strings.Contains(strings.ToLower(upstreamContentType), "application/json") {
		var upstreamPayload any
		if err := json.Unmarshal(upstreamBody, &upstreamPayload); err == nil {
			var proxyPayload any
			if err := json.Unmarshal(proxyBody, &proxyPayload); err != nil {
				t.Fatalf("proxy returned invalid json: %v, body=%s", err, string(proxyBody))
			}

			upstreamNormalized, err := json.Marshal(upstreamPayload)
			if err != nil {
				t.Fatalf("normalize upstream json: %v", err)
			}
			proxyNormalized, err := json.Marshal(proxyPayload)
			if err != nil {
				t.Fatalf("normalize proxy json: %v", err)
			}

			if string(proxyNormalized) != string(upstreamNormalized) {
				t.Fatalf("json mismatch: proxy=%s upstream=%s", string(proxyNormalized), string(upstreamNormalized))
			}
			return
		}
	}

	var wrapper map[string]string
	if err := json.Unmarshal(proxyBody, &wrapper); err != nil {
		t.Fatalf("proxy returned invalid wrapper json: %v, body=%s", err, string(proxyBody))
	}
	if wrapper["result"] != string(upstreamBody) {
		t.Fatalf("wrapper mismatch: proxy result=%q upstream=%q", wrapper["result"], string(upstreamBody))
	}
}

// fakeTimeoutError реализует net.Error с Timeout() == true.
type fakeTimeoutError struct{}

func (fakeTimeoutError) Error() string   { return "fake timeout" }
func (fakeTimeoutError) Timeout() bool   { return true }
func (fakeTimeoutError) Temporary() bool { return false }

func writeTempEnv(t *testing.T, content string) string {
	t.Helper()
	f, err := os.CreateTemp("", "test.env")
	if err != nil {
		t.Fatalf("create temp file: %v", err)
	}
	t.Cleanup(func() { os.Remove(f.Name()) })
	if _, err := f.WriteString(content); err != nil {
		t.Fatalf("write temp file: %v", err)
	}
	f.Close()
	return f.Name()
}

func assertEnv(t *testing.T, key, want string) {
	t.Helper()
	if got := os.Getenv(key); got != want {
		t.Errorf("env %s = %q, want %q", key, got, want)
	}
}

func mustParseTemplate(t *testing.T) *template.Template {
	t.Helper()
	tmpl, err := template.ParseFS(uiFS, "templates/index.html")
	if err != nil {
		t.Fatalf("parse template: %v", err)
	}
	return tmpl
}
