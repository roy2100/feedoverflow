package mcp

import (
	"net/http"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

// Handler returns the Streamable HTTP handler for the MCP server, backed by a
// single shared *sdkmcp.Server — the SDK supports concurrent sessions on one
// server, so (unlike the Node original) there's no need to rebuild it per
// request. Mount on the loopback-only router only; never the public one.
func Handler(port int) http.Handler {
	server := NewServer(port)
	return sdkmcp.NewStreamableHTTPHandler(func(*http.Request) *sdkmcp.Server {
		return server
	}, nil)
}
