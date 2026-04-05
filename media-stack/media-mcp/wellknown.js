app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: "https://mcp.maxibestof.com",
    authorization_servers: ["https://auth.maxibestof.com"], // ou ton vrai IdP
    scopes_supported: ["media:read", "media:write"]
  });
});

