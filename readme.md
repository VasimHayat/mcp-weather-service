# mcp-weather-service

An [MCP](https://modelcontextprotocol.io) server that gives an AI assistant live weather data. It speaks JSON-RPC over **stdio** — there is no HTTP port and nothing to open in a browser. An MCP client (Claude Desktop, Claude Code, the MCP Inspector) spawns the process and talks to it over the pipe.

## Tools

| Tool | Description | Source |
| --- | --- | --- |
| `get_current_weather` | Current conditions for any location worldwide | OpenWeather |
| `get_forecast` | 5-day forecast, collapsed to one line per local day | OpenWeather |
| `get_alerts` | Active alerts for a US state (two-letter code) | US National Weather Service |

`get_current_weather` and `get_forecast` accept either a `location` name (`"Tokyo"`, `"Paris,FR"`) or explicit `latitude`/`longitude`, plus an optional `units` of `metric` (default) or `imperial`.

`get_alerts` is US-only and needs no API key — the NWS API is public. Alerts come from NWS rather than OpenWeather because OpenWeather only exposes them on the paid One Call 3.0 plan.

## Prerequisites

- Node.js 18+ (uses the global `fetch`)
- A free [OpenWeather API key](https://openweathermap.org/api)

## Setup

```bash
npm install
npm run build
```

`build/` is gitignored, so a fresh clone must run `npm run build` before the server will start.

## Configuration

The key is read from the `OPENWEATHER_API_KEY` environment variable and is never hardcoded.

Note that the MCP SDK does **not** pass your shell environment to the server it spawns — on Windows it copies only an allowlist (`PATH`, `APPDATA`, `TEMP`, …). Setting the variable in your terminal is therefore not enough for MCP clients; it must be handed over explicitly via an `env` block or the `-e` flag.

Copy the template and fill in your key:

```bash
cp mcp.example.json mcp.json
```

`mcp.json` is gitignored — keep your real key out of version control.

## Running it

### MCP Inspector

```bash
npm run inspect
```

Serves a web UI at `http://localhost:6274`. Open the URL **including** the `MCP_INSPECTOR_API_TOKEN` query parameter it prints; the token changes on every launch.

`--config` replaces the server command rather than supplementing it — passing both a config file and `node build/index.js` is an error.

For a one-shot check with no browser:

```bash
npx @modelcontextprotocol/inspector --cli --config mcp.json --server weather \
  --method tools/call --tool-name get_current_weather --tool-arg location=Tokyo
```

In `--cli` mode the server command must come **before** any flags. Leading with `-e` yields a misleading `No servers found in config file`.

### Claude Desktop

Add the server to `claude_desktop_config.json`:

- **Windows** — `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS** — `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "weather": {
      "command": "node",
      "args": ["/absolute/path/to/weather-mcp/build/index.js"],
      "env": { "OPENWEATHER_API_KEY": "your-key-here" }
    }
  }
}
```

Use an **absolute** path for `args`. On Windows, prefer an absolute path to `node.exe` (e.g. `C:\\Program Files\\nodejs\\node.exe`) — Claude Desktop launches outside your shell, and a bare `node` failing to resolve is the most common reason the server never appears.

Restart Claude Desktop fully afterward (**File → Exit** — it stays in the tray, so closing the window does not reload the config), then ask *"What's the weather in Tokyo?"*

Server logs land in `%APPDATA%\Claude\logs\mcp-server-weather.log`.

### Claude Code

```bash
claude mcp add weather -e OPENWEATHER_API_KEY=your-key-here -- node /absolute/path/to/weather-mcp/build/index.js
```

## Scripts

| Script | Action |
| --- | --- |
| `npm run build` | Compile TypeScript to `build/` |
| `npm start` | Run the server directly on stdio |
| `npm run inspect` | Launch the MCP Inspector against `mcp.json` |

There is no watch mode: MCP clients execute `build/index.js`, so **run `npm run build` after every change to `src/`** or you will keep testing stale code.

## Project layout

```
src/index.ts        server, tool definitions, API clients
build/index.js      compiled output (gitignored)
mcp.example.json    config template — copy to mcp.json
```

## License

ISC
