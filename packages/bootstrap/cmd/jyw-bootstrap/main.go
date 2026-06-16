package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	modeCode = "code"
	modeChat = "chat"

	defaultProviderName = "JYW Gateway"
	defaultProviderType = "openai-compatible"
)

type config struct {
	mode                   string
	serverURL              string
	loginPath              string
	keysPathTemplate       string
	groupID                string
	username               string
	password               string
	codePath               string
	chatPath               string
	providerName           string
	allowedBaseURLSuffixes []string
	httpTimeout            time.Duration
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type loginResponse struct {
	UserID       string `json:"userId,omitempty"`
	SessionToken string `json:"sessionToken"`
}

type keyResponse struct {
	BaseURL   string      `json:"baseUrl"`
	APIKey    string      `json:"apiKey"`
	ExpiresAt string      `json:"expiresAt,omitempty"`
	Models    []modelInfo `json:"models,omitempty"`
}

type modelInfo struct {
	ID string `json:"id"`
}

type claudeSettings struct {
	Env   map[string]string `json:"env,omitempty"`
	Model string            `json:"model,omitempty"`
}

type deepchatProviderPayload struct {
	Name    string `json:"name"`
	Type    string `json:"type"`
	BaseURL string `json:"baseUrl"`
	APIKey  string `json:"apiKey"`
}

func main() {
	if err := run(context.Background(), os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "jyw-bootstrap: %v\n", err)
		os.Exit(1)
	}
}

func run(parent context.Context, args []string) error {
	cfg, err := loadConfig(args)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(parent, cfg.httpTimeout)
	defer cancel()

	loginCompletedAt := time.Now()
	token, err := login(ctx, cfg)
	if err != nil {
		return err
	}
	logEvent("login_complete", loginCompletedAt)

	keys, err := fetchGroupKey(ctx, cfg, token.SessionToken)
	if err != nil {
		return err
	}
	if err := validateBaseURL(keys.BaseURL, cfg.allowedBaseURLSuffixes); err != nil {
		return err
	}

	models, err := fetchModels(ctx, cfg.httpTimeout, keys.BaseURL, keys.APIKey)
	if err != nil {
		fmt.Fprintf(os.Stderr, "jyw-bootstrap: model list unavailable, continuing: %v\n", err)
	}
	if len(models) > 0 {
		keys.Models = models
	}

	claudeConfigDir, err := writeClaudeSettings(keys)
	if err != nil {
		return err
	}

	switch cfg.mode {
	case modeCode:
		return spawnChild(cfg.codePath, nil, []string{"CLAUDE_CONFIG_DIR=" + claudeConfigDir})
	case modeChat:
		nonce, err := writeDeepchatProviderPayload(cfg.providerName, keys)
		if err != nil {
			return err
		}
		deeplink := fmt.Sprintf("deepchat://provider/install?v=1&from=file&nonce=%s", nonce)
		return spawnChild(cfg.chatPath, []string{deeplink}, nil)
	default:
		return fmt.Errorf("unsupported mode %q", cfg.mode)
	}
}

func loadConfig(args []string) (config, error) {
	cfg := config{
		mode:                   env("JYW_BOOTSTRAP_MODE", ""),
		serverURL:              env("JYW_BOOTSTRAP_SERVER_URL", ""),
		loginPath:              env("JYW_BOOTSTRAP_LOGIN_PATH", "/auth/login"),
		keysPathTemplate:       env("JYW_BOOTSTRAP_KEYS_PATH_TEMPLATE", "/groups/{groupId}/keys"),
		groupID:                env("JYW_BOOTSTRAP_GROUP_ID", ""),
		username:               env("JYW_BOOTSTRAP_USERNAME", ""),
		password:               env("JYW_BOOTSTRAP_PASSWORD", ""),
		codePath:               env("JYW_BOOTSTRAP_CODE_PATH", defaultChildPath(modeCode)),
		chatPath:               env("JYW_BOOTSTRAP_CHAT_PATH", defaultChildPath(modeChat)),
		providerName:           env("JYW_BOOTSTRAP_PROVIDER_NAME", defaultProviderName),
		allowedBaseURLSuffixes: splitCSV(env("JYW_BOOTSTRAP_ALLOWED_BASE_URL_SUFFIXES", "jyw.example.com,.jyw.example.com")),
		httpTimeout:            30 * time.Second,
	}

	flags := flag.NewFlagSet("jyw-bootstrap", flag.ContinueOnError)
	flags.StringVar(&cfg.mode, "mode", cfg.mode, "launch mode: code or chat")
	flags.StringVar(&cfg.serverURL, "server-url", cfg.serverURL, "SaaS server base URL")
	flags.StringVar(&cfg.loginPath, "login-path", cfg.loginPath, "login endpoint path")
	flags.StringVar(&cfg.keysPathTemplate, "keys-path-template", cfg.keysPathTemplate, "group key endpoint path template")
	flags.StringVar(&cfg.groupID, "group-id", cfg.groupID, "SaaS group ID")
	flags.StringVar(&cfg.username, "username", cfg.username, "account login username")
	flags.StringVar(&cfg.password, "password", cfg.password, "account login password")
	flags.StringVar(&cfg.codePath, "code-path", cfg.codePath, "ai-client executable path")
	flags.StringVar(&cfg.chatPath, "chat-path", cfg.chatPath, "DeepChat executable path")
	flags.StringVar(&cfg.providerName, "provider-name", cfg.providerName, "DeepChat provider display name")
	allowedSuffixes := flags.String("allowed-base-url-suffixes", strings.Join(cfg.allowedBaseURLSuffixes, ","), "comma-separated baseUrl host allow-list suffixes")
	timeout := flags.Duration("timeout", cfg.httpTimeout, "HTTP timeout")
	if err := flags.Parse(args); err != nil {
		return config{}, err
	}
	cfg.allowedBaseURLSuffixes = splitCSV(*allowedSuffixes)
	cfg.httpTimeout = *timeout

	if cfg.mode != modeCode && cfg.mode != modeChat {
		return config{}, errors.New("--mode must be code or chat")
	}
	if cfg.serverURL == "" {
		return config{}, errors.New("--server-url or JYW_BOOTSTRAP_SERVER_URL is required")
	}
	if cfg.groupID == "" {
		return config{}, errors.New("--group-id or JYW_BOOTSTRAP_GROUP_ID is required")
	}
	if cfg.username == "" || cfg.password == "" {
		return config{}, errors.New("username/password fallback credentials are required until OAuth UI is implemented")
	}
	if len(cfg.allowedBaseURLSuffixes) == 0 {
		return config{}, errors.New("at least one allowed baseUrl suffix is required")
	}
	return cfg, nil
}

func login(ctx context.Context, cfg config) (loginResponse, error) {
	var response loginResponse
	if err := postJSON(ctx, cfg.httpTimeout, joinServerURL(cfg.serverURL, cfg.loginPath), "", loginRequest{
		Username: cfg.username,
		Password: cfg.password,
	}, &response); err != nil {
		return loginResponse{}, fmt.Errorf("login failed: %w", err)
	}
	if response.SessionToken == "" {
		return loginResponse{}, errors.New("login response missing sessionToken")
	}
	return response, nil
}

func fetchGroupKey(ctx context.Context, cfg config, sessionToken string) (keyResponse, error) {
	var response keyResponse
	keysPath := strings.ReplaceAll(cfg.keysPathTemplate, "{groupId}", url.PathEscape(cfg.groupID))
	if err := postJSON(ctx, cfg.httpTimeout, joinServerURL(cfg.serverURL, keysPath), sessionToken, map[string]string{}, &response); err != nil {
		return keyResponse{}, fmt.Errorf("key issuance failed: %w", err)
	}
	if response.BaseURL == "" || response.APIKey == "" {
		return keyResponse{}, errors.New("key response missing baseUrl or apiKey")
	}
	return response, nil
}

func fetchModels(ctx context.Context, timeout time.Duration, baseURL string, apiKey string) ([]modelInfo, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, modelsURL(baseURL), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{Timeout: timeout}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return nil, fmt.Errorf("GET /models returned HTTP %d", response.StatusCode)
	}

	var body struct {
		Data []modelInfo `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&body); err != nil {
		return nil, err
	}
	return body.Data, nil
}

func postJSON(ctx context.Context, timeout time.Duration, endpoint string, bearerToken string, requestBody any, responseBody any) error {
	encoded, err := json.Marshal(requestBody)
	if err != nil {
		return err
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	if bearerToken != "" {
		request.Header.Set("Authorization", "Bearer "+bearerToken)
	}

	client := &http.Client{Timeout: timeout}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return fmt.Errorf("HTTP %d", response.StatusCode)
	}

	if err := json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(responseBody); err != nil {
		return err
	}
	return nil
}

func writeClaudeSettings(keys keyResponse) (string, error) {
	configDir, err := os.MkdirTemp("", "jyw-bootstrap-claude-")
	if err != nil {
		return "", err
	}
	if err := os.Chmod(configDir, 0o700); err != nil && runtime.GOOS != "windows" {
		return "", err
	}

	settings := claudeSettings{
		Env: map[string]string{
			"ANTHROPIC_BASE_URL":                       keys.BaseURL,
			"ANTHROPIC_AUTH_TOKEN":                     keys.APIKey,
			"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
		},
	}
	if len(keys.Models) > 0 && keys.Models[0].ID != "" {
		settings.Model = keys.Models[0].ID
	}

	payload, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(configDir, "settings.json"), payload, 0o600); err != nil {
		return "", err
	}
	return configDir, nil
}

func writeDeepchatProviderPayload(providerName string, keys keyResponse) (string, error) {
	nonce, err := newNonce()
	if err != nil {
		return "", err
	}

	payloadDir := filepath.Join(os.TempDir(), "jyw-ai-client", "deepchat-provider-install")
	if err := os.MkdirAll(payloadDir, 0o700); err != nil {
		return "", err
	}
	if err := os.Chmod(payloadDir, 0o700); err != nil && runtime.GOOS != "windows" {
		return "", err
	}

	payload := deepchatProviderPayload{
		Name:    providerName,
		Type:    defaultProviderType,
		BaseURL: keys.BaseURL,
		APIKey:  keys.APIKey,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(payloadDir, nonce+".json"), encoded, 0o600); err != nil {
		return "", err
	}
	return nonce, nil
}

func spawnChild(executablePath string, args []string, extraEnv []string) error {
	if executablePath == "" {
		return errors.New("child executable path is empty")
	}
	if _, err := os.Stat(executablePath); err != nil {
		return fmt.Errorf("child executable not found: %s", executablePath)
	}

	command := exec.Command(executablePath, args...)
	command.Env = append(os.Environ(), extraEnv...)
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		return err
	}
	logEvent("child_spawned", time.Now())
	return nil
}

func validateBaseURL(rawBaseURL string, allowedSuffixes []string) error {
	parsed, err := url.Parse(rawBaseURL)
	if err != nil {
		return fmt.Errorf("invalid baseUrl: %w", err)
	}
	if parsed.Scheme != "https" {
		return errors.New("baseUrl must use https")
	}
	host := strings.ToLower(parsed.Hostname())
	for _, suffix := range allowedSuffixes {
		normalizedSuffix := strings.ToLower(strings.TrimSpace(suffix))
		if normalizedSuffix == "" {
			continue
		}
		if strings.HasPrefix(normalizedSuffix, ".") {
			if strings.HasSuffix(host, normalizedSuffix) {
				return nil
			}
			continue
		}
		if host == normalizedSuffix {
			return nil
		}
	}
	return fmt.Errorf("baseUrl host %q is not in allow-list", host)
}

func modelsURL(rawBaseURL string) string {
	parsed, err := url.Parse(rawBaseURL)
	if err != nil {
		return rawBaseURL
	}
	cleanPath := strings.TrimRight(parsed.Path, "/")
	if strings.EqualFold(path.Base(cleanPath), "v1") {
		parsed.Path = cleanPath + "/models"
	} else {
		parsed.Path = cleanPath + "/v1/models"
	}
	return parsed.String()
}

func joinServerURL(serverURL string, endpointPath string) string {
	parsed, err := url.Parse(serverURL)
	if err != nil {
		return serverURL
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/" + strings.TrimLeft(endpointPath, "/")
	return parsed.String()
}

func newNonce() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}

func defaultChildPath(mode string) string {
	executable, err := os.Executable()
	if err != nil {
		return ""
	}
	baseDir := filepath.Dir(executable)
	if runtime.GOOS == "windows" {
		if mode == modeCode {
			return filepath.Join(baseDir, "ai-client", "jyw-ai-client.exe")
		}
		return filepath.Join(baseDir, "deepchat", "DeepChat.exe")
	}
	if mode == modeCode {
		return filepath.Join(baseDir, "ai-client", "jyw-ai-client")
	}
	return filepath.Join(baseDir, "deepchat", "DeepChat")
}

func splitCSV(value string) []string {
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func env(key string, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func logEvent(name string, timestamp time.Time) {
	fmt.Fprintf(os.Stderr, "jyw-bootstrap event=%s ts=%s\n", name, timestamp.UTC().Format(time.RFC3339Nano))
}
