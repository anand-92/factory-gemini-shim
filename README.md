# Factory Gemini Shim

Local OpenAI-compatible proxy for Factory CLI BYOK that makes Gemini behave much closer to Factory's native Google integration.

## Why this exists

Factory's native Gemini integration works, but Gemini through BYOK can fail after tool execution with:

```text
BYOK Error: 400 status code (no body)
```

The main issue is that Factory's generic OpenAI-compatible BYOK path does not preserve enough Gemini-specific tool-call context between turns. This shim accepts Factory's OpenAI-style `/chat/completions` requests, rewrites them to Gemini's native `generateContent` format, and caches the native model tool-call turn so the follow-up tool result request can succeed.

## What it supports

- OpenAI-style `POST /v1/chat/completions`
- OpenAI-style `GET /v1/models`
- Tool/function calling across turns
- Basic SSE streaming format for chat completions

## Requirements

- Node.js 18 or newer
- A Gemini API key
- Factory CLI or Factory desktop using BYOK custom models

## Files

- `server.js`: the proxy
- `package.json`: minimal package metadata
- `start-proxy.cmd`: Windows launcher
- `start-proxy.sh`: macOS/Linux launcher

## Factory settings.json

Put this in your Factory settings file.

Windows:
- `C:\Users\<you>\.factory\settings.json`

macOS/Linux:
- `~/.factory/settings.json`

Example:

```json
{
  "customModels": [
    {
      "model": "gemini-3.1-pro-preview",
      "id": "custom:gemini-api-0",
      "index": 0,
      "baseUrl": "http://127.0.0.1:4310/v1",
      "apiKey": "YOUR_GEMINI_API_KEY",
      "displayName": "Gemini via local shim",
      "maxOutputTokens": 65536,
      "noImageSupport": false,
      "provider": "generic-chat-completion-api"
    }
  ],
  "sessionDefaultSettings": {
    "model": "custom:gemini-api-0"
  }
}
```

Notes:
- Keep `provider` as `generic-chat-completion-api`
- Point `baseUrl` at the local proxy, not Google directly
- The proxy accepts the same bearer token Factory sends, so leaving the Gemini key in Factory is fine

## Run on Windows

From PowerShell:

```powershell
cd C:\path\to\factory-gemini-shim
$env:GEMINI_API_KEY = "your-gemini-key"
node server.js
```

Or use the launcher:

```powershell
cd C:\path\to\factory-gemini-shim
set GEMINI_API_KEY=your-gemini-key
start-proxy.cmd
```

Health check:

```powershell
Invoke-WebRequest http://127.0.0.1:4310/health | Select-Object -ExpandProperty Content
```

## Run on macOS

From Terminal:

```bash
cd /path/to/factory-gemini-shim
export GEMINI_API_KEY="your-gemini-key"
node server.js
```

Or use the launcher:

```bash
cd /path/to/factory-gemini-shim
export GEMINI_API_KEY="your-gemini-key"
chmod +x start-proxy.sh
./start-proxy.sh
```

Health check:

```bash
curl http://127.0.0.1:4310/health
```

## Run in the background

Windows:

```powershell
cd C:\path\to\factory-gemini-shim
$env:GEMINI_API_KEY = "your-gemini-key"
Start-Process node -ArgumentList "server.js" -WorkingDirectory (Get-Location)
```

macOS/Linux:

```bash
cd /path/to/factory-gemini-shim
export GEMINI_API_KEY="your-gemini-key"
nohup node server.js > proxy.out.log 2> proxy.err.log &
```

## Recommended startup order

1. Start the shim
2. Confirm `http://127.0.0.1:4310/health` returns `ok: true`
3. Restart Factory completely
4. Start a session using the BYOK Gemini model

## How it works

Factory sends OpenAI-style chat requests.

The shim:
- translates OpenAI-style messages into Gemini native `contents`
- converts OpenAI `tools` into Gemini `functionDeclarations`
- stores the native Gemini model tool-call turn
- when Factory sends the next turn with a `tool` result, replays the cached native Gemini model turn instead of the lossy generic OpenAI-compatible history

That last step is what avoids the post-tool `400` that can happen with direct Gemini BYOK.

## Limitations

- This is a local compatibility shim, not an official Factory integration
- It currently focuses on chat completions and tool-call continuity
- Streaming is returned in a simple SSE-compatible format, not token-by-token native pass-through
- If Factory changes its BYOK request format, this shim may need an update
- The in-memory tool-call cache is lost when the proxy restarts

## Troubleshooting

If Factory still fails:

1. Make sure the proxy is running
2. Confirm your Factory `baseUrl` is `http://127.0.0.1:4310/v1`
3. Restart Factory after changing `settings.json`
4. Check `proxy.err.log` and `proxy.out.log`
5. Verify your Gemini key works against Google directly

If port `4310` is already in use:

1. Change the port in `server.js`
2. Update Factory `baseUrl` to match

## Development

Start locally:

```bash
node server.js
```

Smoke test:

```bash
curl http://127.0.0.1:4310/health
```
