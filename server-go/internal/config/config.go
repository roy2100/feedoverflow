// Package config is the Go counterpart to server/config.ts + load-env.ts: it
// optionally loads a .env file (without overriding real env vars, like Node's
// process.loadEnvFile) and reads the runtime settings.
package config

import (
	"bufio"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Port           int    // public listener (all interfaces)
	LocalAPIPort   int    // loopback-only no-auth listener
	DBPath         string // SQLite path
	AuthUser       string // empty => auth disabled
	AuthPass       string
	DBMaxSizeBytes int64
	// DisableJobs skips background workers (poller, maintenance, checkpoint,
	// resource monitor, cache warming). Set by RSS_DISABLE_JOBS — the Go analogue
	// of Node keying its jobs off TEST_DB; the contract-diff harness sets it so the
	// Go server never mutates the frozen copy DB mid-run.
	DisableJobs bool
	// ClientDist is the client build served on the public listener (static + SPA).
	ClientDist string
	// LogDir is where NDJSON logs are written (rotated). Empty → jobs/log to stderr.
	LogDir string
}

// Load reads config from the environment. If RSS_ENV_FILE is set (or server/.env
// exists relative to cwd), it is loaded first (non-overriding).
func Load() Config {
	if p := os.Getenv("RSS_ENV_FILE"); p != "" {
		LoadEnvFile(p)
	}
	return Config{
		Port:           envInt("PORT", 3002),
		LocalAPIPort:   envInt("LOCAL_API_PORT", 4002),
		DBPath:         envStr("RSS_DB", "rss.db"),
		AuthUser:       os.Getenv("AUTH_USER"),
		AuthPass:       os.Getenv("AUTH_PASS"),
		DBMaxSizeBytes: int64(envInt("DB_MAX_SIZE_MB", 2048)) * 1024 * 1024,
		DisableJobs:    os.Getenv("RSS_DISABLE_JOBS") != "",
		ClientDist:     envStr("CLIENT_DIST", "client/dist"),
		LogDir:         os.Getenv("LOG_DIR"),
	}
}

// LoadEnvFile parses a KEY=VALUE .env file and sets any vars not already present
// in the environment (matching Node's non-overriding process.loadEnvFile).
func LoadEnvFile(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq < 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		val = strings.Trim(val, `"'`)
		if key != "" {
			if _, ok := os.LookupEnv(key); !ok {
				_ = os.Setenv(key, val)
			}
		}
	}
}

func envStr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}
