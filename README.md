# OpenRouter API 透明代理 (openrouter-proxy)

> 这是一个部署在 Cloudflare Workers 上的 OpenRouter API 透明代理中转服务。专为中国大陆等网络受阻地区用户设计，它纯粹提供线路转发，在最少干预的前提下优雅伪装为境外发起的请求。

它旨在解决以下问题：
*   **网络阻断**：提供直连 OpenRouter (https://openrouter.ai) 的境外线路跳板，让你规避大陆对域名的请求拦截。
*   **跨域请求**：完美解决前端或网页直连服务器调用 OpenRouter 时遭受的 CORS 跨域问题。
*   **完全透明**：没有任何内置密码和密钥拦截配置，只需带上你自己的 API 密钥发向你的自定义域名，代理原封不动帮你安全透传。
*   **全面特性支持**：原生无损透传所有流式响应(SSE)、多模态图片识别、图片生成及工具调用等所有功能。

## ✨ 主要功能

*   **完全零干预转发**: 将客户端送往 `/v1/*` 的请求直接带上头部等信息通过你的 Worker 节点前往 `https://openrouter.ai/api/v1/*`。
*   **全流式支持**: 利用底层 `fetch` API，不对数据体做缓冲拦截，保证最快的高速流式响应体验。
*   **轻量化代码**: 由于作为透明转发，不包含厚重的包和复杂的中间件，使得资源消耗极低，免费额度完全够用。

## 🚀 部署与使用

### 部署到 Cloudflare

1.  **准备环境**
    你需要在本地安装有 Node.js 以及 `pnpm`。

2.  **安装依赖与部署**
    你可以直接将本项目通过 Wrangler 部署：
    ```bash
    pnpm install
    # 登录 wrangler 并部署
    npx wrangler login
    pnpm run deploy
    ```
    部署成功后，Wrangler 会输出你的 Worker URL（如 `xxxx.your-name.workers.dev`）。

## 💻 客户端配置

在支持填入自定义 API Base URL 的 AI 工具（例如沉浸式翻译、NextChat、或者你的代码中）按照下面的方式填写：

- **BaseURL**: `<你的 Worker 地址>` (或者精准写为: `<你的 Worker 地址>/v1`)
- **API 密钥**: `<你真实的 OpenRouter API 密钥>` (形如 `sk-or-v1-...`)

这样客户端的每一次请求，最终都会被当做海外节点顺利中转给 OpenRouter 处理。

## 测试脚本支持

项目中附带了 PowerShell 编写的验证测试脚本，你只需要将内部的 `$API_ENDPOINT` 改为你部署的 Worker 域名，并填入你自己的 OpenRouter Key，就可以检查连通性：
- `test-api.ps1`: 用于测试常规的文本模型对话和网络延迟。
- `test-image.ps1`: 用于展示和测试如何发送带 `modalities` 的请求来生成图片并保存到本地。
