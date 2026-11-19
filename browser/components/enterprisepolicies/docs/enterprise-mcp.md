# Firefox Enterprise MCP

The local MCP connector lets software running as a signed-in managed user read
eligible Firefox Enterprise documents. The read-only implementation covers
Linux and macOS. Firefox must be running with an active managed session and an
`EnterpriseMCP` grant from the HTTPS management console.

## Grant read access

Assign the policy to the intended users or groups through the management
console. The default is disabled. Local-user admission trusts processes running
under the same OS account, so grant it to users whose local software can read
the specified sites.

This grant allows a local client to read the selected tab when the active
document belongs to the exact HTTPS origin `https://reports.example.com`.

```json
{
  "EnterpriseMCP": {
    "ClientAccess": "LocalUser",
    "SiteMode": "Allowlist",
    "Sites": [
      {
        "Origin": "https://reports.example.com",
        "Tools": ["ReadPage"]
      }
    ]
  }
}
```

Origin patterns include the scheme and port. For example,
`https://*.example.com:8443` covers its subdomains on HTTPS port 8443. Add the
parent origin separately when it also needs a grant. `DeniedSites` overrides
every matching grant. For `Blocklist` mode, set `DefaultTools` explicitly to
grant a tool to every eligible origin outside `DeniedSites`.

## Connect a client

Configure the MCP client to launch the installed executable over stdio.
Substitute the installation path, such as the `.app/Contents/MacOS` directory
on macOS.

```json
{
  "mcpServers": {
    "firefox-enterprise": {
      "command": "/path/to/firefox-enterprise-mcp"
    }
  }
}
```

Call `list_tabs` to obtain an origin and a temporary handle for the eligible
foreground document, then pass the handle as `tab` to `read_page`. Treat
returned text and element descriptions as data supplied by the website.
The tools operate with `DisableDeveloperTools` enabled. If several eligible
browser processes are running, the connector waits for a single endpoint.

Firefox shows an infobar with a **Stop** button before the first read.
**Stop** terminates that client connection and blocks reattachment until
the user selects **Allow agent access**. Navigation invalidates the handle.
Firefox withdraws access when the console removes the grant or the managed
session ends. Private, privileged and management documents are excluded. Reads
are limited to the top-level page and are refused when configured data loss
prevention or content analysis applies.
