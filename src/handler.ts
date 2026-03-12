import { Env } from './index';

class HttpError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = this.constructor.name;
		this.status = status;
	}
}

const fixCors = ({ headers, status, statusText }: { headers?: HeadersInit; status?: number; statusText?: string }) => {
	const newHeaders = new Headers(headers);
	newHeaders.set('Access-Control-Allow-Origin', '*');
	newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
	newHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-goog-api-key');
	return { headers: newHeaders, status, statusText };
};

const BASE_URL = 'https://aiplatform.googleapis.com';
const API_VERSION = 'v1/publishers/google';
const API_CLIENT = 'genai-js/0.21.0';

const makeHeaders = (apiKey: string, more?: Record<string, string>) => ({
	'x-goog-api-client': API_CLIENT,
	...(apiKey && { 'x-goog-api-key': apiKey }),
	...more,
});


	async function forwardRequest(targetUrl: string, request: Request, headers: Headers, apiKey: string): Promise<Response> {
		console.log(`Request Sending to Vertex AI: ${targetUrl}`);

		const response = await fetch(targetUrl, {
			method: request.method,
			headers: headers,
			body: request.method === 'GET' || request.method === 'HEAD' ? null : request.body,
		});

		if (response.status === 429) {
			console.log(`API key ${apiKey} received 429 status code.`);
		}

		console.log('Call Vertex AI Success');

		const responseHeaders = new Headers(response.headers);
		responseHeaders.set('Access-Control-Allow-Origin', '*');
		responseHeaders.delete('transfer-encoding');
		responseHeaders.delete('connection');
		responseHeaders.delete('keep-alive');
		responseHeaders.delete('content-encoding');
		responseHeaders.set('Referrer-Policy', 'no-referrer');

		return new Response(response.body, {
			status: response.status,
			headers: responseHeaders,
		});
	}

	export async function handleProxy(request: Request, env: Env): Promise<Response> {
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: fixCors({}).headers,
			});
		}

		const url = new URL(request.url);
		const pathname = url.pathname;

		// 静态资源直接放行
		if (pathname === '/favicon.ico' || pathname === '/robots.txt') {
			return new Response('', { status: 204 });
		}

		const search = url.search;
		const authKey = env.AUTH_KEY;
		const apiKey = env.API_KEY;

		// 传统模式：验证 AUTH_KEY
		if (authKey) {
			let isAuthorized = false;
			// Check key in query parameters
			if (search.includes('key=')) {
				const requestKey = url.searchParams.get('key');
				if (requestKey && requestKey === authKey) {
					isAuthorized = true;
				}
			} else {
				// Check Authorization header or x-goog-api-key
				const requestKey = request.headers.get('x-goog-api-key');
				const authHeader = request.headers.get('Authorization');
				if (requestKey && requestKey === authKey) {
					isAuthorized = true;
				} else if (authHeader && authHeader.replace(/^Bearer\s+/, '') === authKey) {
					isAuthorized = true;
				}
			}

			if (!isAuthorized) {
				return new Response('Unauthorized', { status: 401, headers: fixCors({}).headers });
			}
		}

		if (!apiKey) {
			return new Response('API_KEY is missing in environment variables', { status: 500, headers: fixCors({}).headers });
		}

		// OpenAI compatible routes
		if (
			pathname.endsWith('/chat/completions') ||
			pathname.endsWith('/completions') ||
			pathname.endsWith('/embeddings') ||
			pathname.endsWith('/v1/models')
		) {
			return handleOpenAI(request, apiKey);
		}

		// Direct Proxy to Vertex AI
		let targetUrl = `${BASE_URL}${pathname}${search}`;
		const targetUrlObj = new URL(targetUrl);
		targetUrlObj.searchParams.set('key', apiKey);
		
		let headers = new Headers();
		if (request.headers.has('content-type')) {
			headers.set('content-type', request.headers.get('content-type')!);
		}
		headers.set('x-goog-api-key', apiKey);

		return forwardRequest(targetUrlObj.toString(), request, headers, apiKey);
	}


	async function handleModels(apiKey: string) {
		const response = await fetch(`${BASE_URL}/${API_VERSION}/models`, {
			headers: makeHeaders(apiKey),
		});

		let responseBody: BodyInit | null = response.body;
		if (response.ok) {
			const { models } = JSON.parse(await response.text());
			responseBody = JSON.stringify(
				{
					object: 'list',
					data: (models || []).map(({ name }: any) => ({
						id: name.replace('models/', '').replace('publishers/google/models/', ''),
						object: 'model',
						created: 0,
						owned_by: '',
					})),
				},
				null,
				'  '
			);
		}
		return new Response(responseBody, fixCors(response));
	}

	async function handleEmbeddings(req: any, apiKey: string) {
		const DEFAULT_EMBEDDINGS_MODEL = 'text-embedding-004';

		if (typeof req.model !== 'string') {
			throw new HttpError('model is not specified', 400);
		}

		let model;
		if (req.model.startsWith('models/')) {
			model = req.model;
		} else {
			if (!req.model.startsWith('gemini-')) {
				req.model = DEFAULT_EMBEDDINGS_MODEL;
			}
			model = 'models/' + req.model;
		}

		if (!Array.isArray(req.input)) {
			req.input = [req.input];
		}

		const response = await fetch(`${BASE_URL}/${API_VERSION}/${model}:batchEmbedContents`, {
			method: 'POST',
			headers: makeHeaders(apiKey, { 'Content-Type': 'application/json' }),
			body: JSON.stringify({
				requests: req.input.map((text: string) => ({
					model,
					content: { parts: { text } },
					outputDimensionality: req.dimensions,
				})),
			}),
		});

		let responseBody: BodyInit | null = response.body;
		if (response.ok) {
			const { embeddings } = JSON.parse(await response.text());
			responseBody = JSON.stringify(
				{
					object: 'list',
					data: (embeddings || []).map(({ values }: any, index: number) => ({
						object: 'embedding',
						index,
						embedding: values,
					})),
					model: req.model,
				},
				null,
				'  '
			);
		}
		return new Response(responseBody, fixCors(response));
	}

	async function handleCompletions(req: any, apiKey: string) {
		const DEFAULT_MODEL = 'gemini-2.5-flash';
		let model = DEFAULT_MODEL;

		switch (true) {
			case typeof req.model !== 'string':
				break;
			case req.model.startsWith('models/'):
				model = req.model.substring(7);
				break;
			case req.model.startsWith('gemini-'):
			case req.model.startsWith('gemma-'):
			case req.model.startsWith('learnlm-'):
				model = req.model;
		}

		let body = await transformRequest(req);
		const extra = req.extra_body?.google;

		if (extra) {
			if (extra.safety_settings) {
				body.safetySettings = extra.safety_settings;
			}
			if (extra.cached_content) {
				body.cachedContent = extra.cached_content;
			}
			if (extra.thinking_config) {
				body.generationConfig.thinkingConfig = extra.thinking_config;
			}
		}

		switch (true) {
			case model.endsWith(':search'):
				model = model.substring(0, model.length - 7);
			case req.model.endsWith('-search-preview'):
			case req.tools?.some((tool: any) => tool.function?.name === 'googleSearch'):
				body.tools = body.tools || [];
				body.tools.push({ function_declarations: [{ name: 'googleSearch', parameters: {} }] });
		}

		const TASK = req.stream ? 'streamGenerateContent' : 'generateContent';
		let url = `${BASE_URL}/${API_VERSION}/models/${model}:${TASK}`;
		if (req.stream) {
			url += '?alt=sse';
		}

		const response = await fetch(url, {
			method: 'POST',
			headers: makeHeaders(apiKey, { 'Content-Type': 'application/json' }),
			body: JSON.stringify(body),
		});

		let responseBody: BodyInit | null = response.body;
		if (response.ok) {
			let id = 'chatcmpl-' + generateId();
			const shared = {};

			if (req.stream) {
				responseBody = response
					.body!.pipeThrough(new TextDecoderStream())
					.pipeThrough(
						new TransformStream({
							transform: parseStream,
							flush: parseStreamFlush,
							buffer: '',
							shared,
						} as any)
					)
					.pipeThrough(
						new TransformStream({
							transform: toOpenAiStream,
							flush: toOpenAiStreamFlush,
							streamIncludeUsage: req.stream_options?.include_usage,
							model,
							id,
							last: [],
							reasoningLast: [],
							shared,
						} as any)
					)
					.pipeThrough(new TextEncoderStream());
			} else {
				let body: any = await response.text();
				try {
					body = JSON.parse(body);
					if (!body.candidates) {
						throw new Error('Invalid completion object');
					}
				} catch (err) {
					console.error('Error parsing response:', err);
					return new Response(JSON.stringify({ error: 'Failed to parse response' }), {
						...fixCors(response),
						status: 500,
					});
				}
				responseBody = processCompletionsResponse(body, model, id);
			}
		}
		return new Response(responseBody, fixCors(response));
	}

	async function handleOpenAI(request: Request, apiKey: string) {
		const url = new URL(request.url);
		const pathname = url.pathname;
        
		if (request.method !== 'POST' && pathname !== '/v1/models') {
			return new Response(null, { status: 405, headers: fixCors({}).headers });
		}

		if (pathname === '/v1/models') {
			return handleModels(apiKey);
		}

		let req;
		try {
			req = await request.json();
		} catch (e) {
			return new Response('Invalid JSON payload', { status: 400, headers: fixCors({}).headers });
		}
		
		if (pathname.endsWith('/embeddings')) {
			return handleEmbeddings(req, apiKey);
		} else if (pathname.endsWith('/completions') || pathname.endsWith('/chat/completions')) {
			return handleCompletions(req, apiKey);
		}
		return new Response('Unknown OpenAI Endpoint', { status: 404, headers: fixCors({}).headers });
	}

	// 辅助方法
	function generateId(): string {
		const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		const randomChar = () => characters[Math.floor(Math.random() * characters.length)];
		return Array.from({ length: 29 }, randomChar).join('');
	}

	async function transformRequest(req: any) {
		const harmCategory = [
			'HARM_CATEGORY_HATE_SPEECH',
			'HARM_CATEGORY_SEXUALLY_EXPLICIT',
			'HARM_CATEGORY_DANGEROUS_CONTENT',
			'HARM_CATEGORY_HARASSMENT',
			'HARM_CATEGORY_CIVIC_INTEGRITY',
		];

		const safetySettings = harmCategory.map((category) => ({
			category,
			threshold: 'BLOCK_NONE',
		}));

		return {
			...(await transformMessages(req.messages)),
			safetySettings,
			generationConfig: transformConfig(req),
			...transformTools(req),
			cachedContent: undefined as any,
		};
	}

	function transformConfig(req: any) {
		const fieldsMap: Record<string, string> = {
			frequency_penalty: 'frequencyPenalty',
			max_completion_tokens: 'maxOutputTokens',
			max_tokens: 'maxOutputTokens',
			n: 'candidateCount',
			presence_penalty: 'presencePenalty',
			seed: 'seed',
			stop: 'stopSequences',
			temperature: 'temperature',
			top_k: 'topK',
			top_p: 'topP',
		};

		const thinkingBudgetMap: Record<string, number> = {
			low: 1024,
			medium: 8192,
			high: 24576,
		};

		let cfg: any = {};
		for (let key in req) {
			const matchedKey = fieldsMap[key];
			if (matchedKey) {
				cfg[matchedKey] = req[key];
			}
		}

		if (req.response_format) {
			switch (req.response_format.type) {
				case 'json_schema':
					cfg.responseSchema = req.response_format.json_schema?.schema;
					if (cfg.responseSchema && 'enum' in cfg.responseSchema) {
						cfg.responseMimeType = 'text/x.enum';
						break;
					}
				case 'json_object':
					cfg.responseMimeType = 'application/json';
					break;
				case 'text':
					cfg.responseMimeType = 'text/plain';
					break;
				default:
					throw new HttpError('Unsupported response_format.type', 400);
			}
		}
		if (req.reasoning_effort) {
			cfg.thinkingConfig = { thinkingBudget: thinkingBudgetMap[req.reasoning_effort] };
		}

		return cfg;
	}

	async function transformMessages(messages: any[]) {
		if (!messages) {
			return {};
		}

		const contents: any[] = [];
		let system_instruction;

		for (const item of messages) {
			switch (item.role) {
				case 'system':
					system_instruction = { parts: await transformMsg(item) };
					continue;
				case 'assistant':
					item.role = 'model';
					break;
				case 'user':
					break;
				default:
					throw new HttpError(`Unknown message role: "${item.role}"`, 400);
			}

			if (system_instruction) {
				// 修复：确保 parts 是数组后再调用 some 方法
				if (!contents[0]?.parts || (Array.isArray(contents[0]?.parts) && !contents[0]?.parts.some((part: any) => part.text))) {
					contents.unshift({ role: 'user', parts: [{ text: ' ' }] });
				}
			}

			contents.push({
				role: item.role,
				parts: await transformMsg(item),
			});
		}

		return { system_instruction, contents };
	}

	async function transformMsg({ content }: any) {
		const parts = [];
		if (!Array.isArray(content)) {
			parts.push({ text: content });
			return parts;
		}

		for (const item of content) {
			switch (item.type) {
				case 'text':
					parts.push({ text: item.text });
					break;
				case 'image_url':
					parts.push(await parseImg(item.image_url.url));
					break;
				case 'input_audio':
					parts.push({
						inlineData: {
							mimeType: 'audio/' + item.input_audio.format,
							data: item.input_audio.data,
						},
					});
					break;
				default:
					throw new HttpError(`Unknown "content" item type: "${item.type}"`, 400);
			}
		}

		if (content.every((item) => item.type === 'image_url')) {
			parts.push({ text: '' }); // to avoid "Unable to submit request because it must have a text parameter"
		}
		return parts;
	}
	async function parseImg(url: any) {
		let mimeType, data;
		if (url.startsWith('http://') || url.startsWith('https://')) {
			try {
				const response = await fetch(url);
				if (!response.ok) {
					throw new Error(`${response.status} ${response.statusText} (${url})`);
				}
				mimeType = response.headers.get('content-type');
				data = Buffer.from(await response.arrayBuffer()).toString('base64');
			} catch (err) {
				throw new Error('Error fetching image: ' + (err as Error).message);
			}
		} else {
			const match = url.match(/^data:(?<mimeType>.*?)(;base64)?,(?<data>.*)$/);
			if (!match) {
				throw new HttpError('Invalid image data: ' + url, 400);
			}
			({ mimeType, data } = match.groups);
		}
		return {
			inlineData: {
				mimeType,
				data,
			},
		};
	}

	function adjustSchema(schema: any) {
		const obj = schema[schema.type];
		delete obj.strict;
		return adjustProps(schema);
	}

	function adjustProps(schemaPart: any) {
		if (typeof schemaPart !== 'object' || schemaPart === null) {
			return;
		}
		if (Array.isArray(schemaPart)) {
			schemaPart.forEach(adjustProps);
		} else {
			if (schemaPart.type === 'object' && schemaPart.properties && schemaPart.additionalProperties === false) {
				delete schemaPart.additionalProperties;
			}
			Object.values(schemaPart).forEach(adjustProps);
		}
	}

	function transformTools(req: any) {
		let tools, tool_config;
		if (req.tools) {
			const funcs = req.tools.filter((tool: any) => tool.type === 'function' && tool.function?.name !== 'googleSearch');
			if (funcs.length > 0) {
				funcs.forEach(adjustSchema);
				tools = [{ function_declarations: funcs.map((schema: any) => schema.function) }];
			}
		}
		if (req.tool_choice) {
			const allowed_function_names = req.tool_choice?.type === 'function' ? [req.tool_choice?.function?.name] : undefined;
			if (allowed_function_names || typeof req.tool_choice === 'string') {
				tool_config = {
					function_calling_config: {
						mode: allowed_function_names ? 'ANY' : req.tool_choice.toUpperCase(),
						allowed_function_names,
					},
				};
			}
		}
		return { tools, tool_config };
	}

	function processCompletionsResponse(data: any, model: string, id: string) {
		const reasonsMap: Record<string, string> = {
			STOP: 'stop',
			MAX_TOKENS: 'length',
			SAFETY: 'content_filter',
			RECITATION: 'content_filter',
		};

		const transformCandidatesMessage = (cand: any) => {
			const message = { role: 'assistant', content: [] as string[] };
			let reasoningContent = '';
			let finalContent = '';

			for (const part of cand.content?.parts ?? []) {
				if (part.text) {
					// 检查是否是思考内容
					// Gemini API 可能使用多种方式标识思考内容
					const isThoughtContent =
						part.thoughtToken ||
						part.thought ||
						part.thoughtTokens ||
						(part.executableCode && part.executableCode.language === 'thought') ||
						// 检查文本是否以思考标记开头
						(part.text && (part.text.startsWith('<thinking>') || part.text.startsWith('思考：') || part.text.startsWith('Thinking:')));

					if (isThoughtContent) {
						// 这是思考内容，应该放在 reasoning_content 字段中
						// 如果文本包含思考标记，需要移除这些标记
						let cleanText = part.text;
						if (cleanText.startsWith('<thinking>')) {
							cleanText = cleanText.replace('<thinking>', '').replace('</thinking>', '');
						} else if (cleanText.startsWith('思考：')) {
							cleanText = cleanText.replace('思考：', '');
						} else if (cleanText.startsWith('Thinking:')) {
							cleanText = cleanText.replace('Thinking:', '');
						}
						reasoningContent += cleanText;
					} else {
						// 这是正常的回答内容
						finalContent += part.text;
					}
				}
			}

			const messageObj: any = {
				index: cand.index || 0,
				message: {
					role: 'assistant',
					content: finalContent || null,
				},
				logprobs: null,
				finish_reason: reasonsMap[cand.finishReason] || cand.finishReason,
			};

			// 如果有思考内容，添加到响应中
			if (reasoningContent) {
				messageObj.message.reasoning_content = reasoningContent;
			}

			return messageObj;
		};

		const obj = {
			id,
			choices: data.candidates.map(transformCandidatesMessage),
			created: Math.floor(Date.now() / 1000),
			model: data.modelVersion ?? model,
			object: 'chat.completion',
			usage: data.usageMetadata && {
				completion_tokens: data.usageMetadata.candidatesTokenCount,
				prompt_tokens: data.usageMetadata.promptTokenCount,
				total_tokens: data.usageMetadata.totalTokenCount,
			},
		};

		return JSON.stringify(obj);
	}

	// 流处理方法
	function parseStream(this: any, chunk: string, controller: any) {
		this.buffer += chunk;
		const lines = this.buffer.split('\n');
		this.buffer = lines.pop()!;

		for (const line of lines) {
			if (line.startsWith('data: ')) {
				const data = line.substring(6);
				if (data.startsWith('{')) {
					controller.enqueue(JSON.parse(data));
				}
			}
		}
	}

	function parseStreamFlush(this: any, controller: any) {
		if (this.buffer) {
			try {
				controller.enqueue(JSON.parse(this.buffer));
				this.shared.is_buffers_rest = true;
			} catch (e) {
				console.error('Error parsing remaining buffer:', e);
			}
		}
	}

	function toOpenAiStream(this: any, line: any, controller: any) {
		const reasonsMap: Record<string, string> = {
			STOP: 'stop',
			MAX_TOKENS: 'length',
			SAFETY: 'content_filter',
			RECITATION: 'content_filter',
		};

		const { candidates, usageMetadata } = line;
		if (usageMetadata) {
			this.shared.usage = {
				completion_tokens: usageMetadata.candidatesTokenCount,
				prompt_tokens: usageMetadata.promptTokenCount,
				total_tokens: usageMetadata.totalTokenCount,
			};
		}

		if (candidates) {
			for (const cand of candidates) {
				const { index, content, finishReason } = cand;
				const { parts } = content;

				// 分别处理思考内容和正常内容
				let reasoningText = '';
				let finalText = '';

				for (const part of parts) {
					if (part.text) {
						// 检查是否是思考内容
						// Gemini API 可能使用多种方式标识思考内容
						const isThoughtContent =
							part.thoughtToken ||
							part.thought ||
							part.thoughtTokens ||
							(part.executableCode && part.executableCode.language === 'thought') ||
							// 检查文本是否以思考标记开头
							(part.text && (part.text.startsWith('<thinking>') || part.text.startsWith('思考：') || part.text.startsWith('Thinking:')));

						if (isThoughtContent) {
							// 这是思考内容
							// 如果文本包含思考标记，需要移除这些标记
							let cleanText = part.text;
							if (cleanText.startsWith('<thinking>')) {
								cleanText = cleanText.replace('<thinking>', '').replace('</thinking>', '');
							} else if (cleanText.startsWith('思考：')) {
								cleanText = cleanText.replace('思考：', '');
							} else if (cleanText.startsWith('Thinking:')) {
								cleanText = cleanText.replace('Thinking:', '');
							}
							reasoningText += cleanText;
						} else {
							// 这是正常的回答内容
							finalText += part.text;
						}
					}
				}

				// 处理思考内容的流式输出
				if (reasoningText) {
					if (!this.reasoningLast) this.reasoningLast = {};
					if (this.reasoningLast[index] === undefined) {
						this.reasoningLast[index] = '';
					}

					const lastReasoningText = this.reasoningLast[index] || '';
					let reasoningDelta = '';

					if (reasoningText.startsWith(lastReasoningText)) {
						reasoningDelta = reasoningText.substring(lastReasoningText.length);
					} else {
						// Find the common prefix
						let i = 0;
						while (i < reasoningText.length && i < lastReasoningText.length && reasoningText[i] === lastReasoningText[i]) {
							i++;
						}
						reasoningDelta = reasoningText.substring(i);
					}

					this.reasoningLast[index] = reasoningText;

					if (reasoningDelta) {
						const reasoningObj = {
							id: this.id,
							object: 'chat.completion.chunk',
							created: Math.floor(Date.now() / 1000),
							model: this.model,
							choices: [
								{
									index,
									delta: { reasoning_content: reasoningDelta },
									finish_reason: null,
								},
							],
						};
						controller.enqueue(`data: ${JSON.stringify(reasoningObj)}\n\n`);
					}
				}

				// 处理正常内容的流式输出
				if (finalText) {
					if (this.last[index] === undefined) {
						this.last[index] = '';
					}

					const lastText = this.last[index] || '';
					let delta = '';

					if (finalText.startsWith(lastText)) {
						delta = finalText.substring(lastText.length);
					} else {
						// Find the common prefix
						let i = 0;
						while (i < finalText.length && i < lastText.length && finalText[i] === lastText[i]) {
							i++;
						}
						// Send the rest of the new text as delta.
						// This might not be perfect for all clients, but it prevents data loss.
						delta = finalText.substring(i);
					}

					this.last[index] = finalText;

					if (delta) {
						const obj = {
							id: this.id,
							object: 'chat.completion.chunk',
							created: Math.floor(Date.now() / 1000),
							model: this.model,
							choices: [
								{
									index,
									delta: { content: delta },
									finish_reason: null,
								},
							],
						};
						controller.enqueue(`data: ${JSON.stringify(obj)}\n\n`);
					}
				}

				// 如果有完成原因，发送完成信号
				if (finishReason) {
					const finishObj = {
						id: this.id,
						object: 'chat.completion.chunk',
						created: Math.floor(Date.now() / 1000),
						model: this.model,
						choices: [
							{
								index,
								delta: {},
								finish_reason: reasonsMap[finishReason] || finishReason,
							},
						],
					};
					controller.enqueue(`data: ${JSON.stringify(finishObj)}\n\n`);
				}
			}
		}
	}

	function toOpenAiStreamFlush(this: any, controller: any) {
		if (this.streamIncludeUsage && this.shared.usage) {
			const obj = {
				id: this.id,
				object: 'chat.completion.chunk',
				created: Math.floor(Date.now() / 1000),
				model: this.model,
				choices: [
					{
						index: 0,
						delta: {},
						finish_reason: 'stop',
					},
				],
				usage: this.shared.usage,
			};
			controller.enqueue(`data: ${JSON.stringify(obj)}\n\n`);
		}
		controller.enqueue('data: [DONE]\n\n');
	}
