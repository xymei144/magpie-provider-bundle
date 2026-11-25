/**
 * The ModelBest（面壁智能）model snapshot.
 *
 * Source: `GET https://platform.modelbest.cn/api/models` (public, no token),
 * read 2026-11-07. Only models that speak `POST /v1/chat/completions` are
 * listed: the OCR models answer on `/v1/document-parse`, VoxCPM2 on
 * `/v1/audio/speech`, and MiniCPM-o Realtime is a websocket session, so none
 * of them can be served by the OpenAI-compatible chat path this provider
 * declares.
 *
 * The platform does not publish `max_output_tokens` for these models (the
 * field is 0), so `DEFAULT_OUTPUT` is a conservative send ceiling, not a
 * vendor claim.
 */

export const NPM = "@ai-sdk/openai-compatible"
export const DEFAULT_BASE_URL = "https://api.modelbest.cn/v1"
export const DEFAULT_MODEL = "MiniCPM-V-4.7-35B-A3B"

const DEFAULT_CONTEXT = 131072
const DEFAULT_OUTPUT = 8192

/** `GET /api/models` entries, reduced to the fields this provider uses. */
export const CATALOG = [
  {
    id: "MiniCPM-V-4.7-35B-A3B",
    name: "MiniCPM-V-4.7-35B-A3B",
    context: 256000,
    image: true,
    video: true,
    tools: true,
    reasoning: true,
    free: true,
  },
  {
    id: "MiniCPM-V-4.7-1B",
    name: "MiniCPM-V-4.7-1B",
    context: 256000,
    image: true,
    video: true,
    tools: true,
    reasoning: true,
    free: true,
  },
  {
    id: "MiniCPM5-2B",
    name: "MiniCPM5-2B",
    context: 128000,
    image: false,
    video: false,
    tools: false,
    reasoning: false,
    free: false,
  },
]

export function allModels(options = {}) {
  const modelId =
    typeof options.modelId === "string" && options.modelId.trim()
      ? options.modelId.trim()
      : DEFAULT_MODEL
  return CATALOG.map((model) =>
    model.id === DEFAULT_MODEL ? { ...model, id: modelId, name: modelId } : model,
  )
}

export function inputModalities(model) {
  return ["text", ...(model.image ? ["image"] : []), ...(model.video ? ["video"] : [])]
}

export function toConfigModel(model) {
  return {
    name: model.name,
    reasoning: model.reasoning === true,
    tool_call: model.tools === true,
    attachment: model.image === true,
    modalities: { input: inputModalities(model), output: ["text"] },
    limit: {
      context: model.context || DEFAULT_CONTEXT,
      output: model.output || DEFAULT_OUTPUT,
    },
  }
}

export function toProviderModel(model, providerID, baseURL) {
  return {
    id: model.id,
    providerID,
    name: model.name,
    api: { id: model.id, url: baseURL, npm: NPM },
    status: "active",
    headers: {},
    options: {},
    // Credits are the platform's own unit, not a dollar price, so no cost is
    // claimed here even when `input_pricing` is non-zero.
    cost: {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    },
    limit: {
      context: model.context || DEFAULT_CONTEXT,
      output: model.output || DEFAULT_OUTPUT,
    },
    capabilities: {
      temperature: true,
      reasoning: model.reasoning === true,
      attachment: model.image === true,
      toolcall: model.tools === true,
      input: {
        text: true,
        audio: false,
        image: model.image === true,
        video: model.video === true,
        pdf: false,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: model.reasoning === true ? { field: "reasoning_content" } : false,
    },
    release_date: "",
    variants: {},
  }
}
