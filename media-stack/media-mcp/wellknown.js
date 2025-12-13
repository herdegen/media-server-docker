app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  const domain = process.env.MCP_DOMAIN || "mcp.example.com";
  res.json({
    resource: `https://${domain}`,
    authorization_servers: [`https://auth.${domain}`],
    scopes_supported: ["media:read", "media:write"]
  });
});

