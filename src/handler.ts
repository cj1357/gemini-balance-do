import { Env } from './index';

const fixCors = ({ headers, status, statusText }: { headers?: HeadersInit; status?: number; statusText?: string }) => {
	const newHeaders = new Headers(headers);
	newHeaders.set('Access-Control-Allow-Origin', '*');
	newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
	newHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-goog-api-key');
	return { headers: newHeaders, status, statusText };
};

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api';

export async function handleProxy(request: Request, env: Env): Promise<Response> {
	try {
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: fixCors({}).headers,
			});
		}

		const url = new URL(request.url);
		let pathname = url.pathname;

		if (pathname === '/favicon.ico' || pathname === '/robots.txt') {
			return new Response('', { status: 204 });
		}

		// Ensure pathname is mapped correctly for OpenRouter
		if (!pathname.startsWith('/v1/')) {
			if (pathname.startsWith('/chat/')) {
				pathname = '/v1' + pathname;
			}
		}

		const headers = new Headers(request.headers);
		// Remove Host so OpenRouter doesn't reject it
		headers.delete('Host');
		
		// If client passed key via url param, move it to authorization header so OpenRouter sees it
		if (url.searchParams.has('key')) {
			const key = url.searchParams.get('key');
			if (key && !headers.has('Authorization')) {
				headers.set('Authorization', `Bearer ${key}`);
			}
			url.searchParams.delete('key');
		}

		// Recommended OpenRouter Headers (only set if client didn't provide them)
		if (!headers.has('HTTP-Referer')) {
			headers.set('HTTP-Referer', 'https://github.com/zaunist/gemini-balance-do'); 
		}
		if (!headers.has('X-Title')) {
			headers.set('X-Title', 'OpenRouter Proxy');
		}

		const targetUrl = `${OPENROUTER_BASE_URL}${pathname}${url.search}`;

		const init: RequestInit = {
			method: request.method,
			headers,
			redirect: 'follow'
		};

		// Only pass body for non-GET/HEAD methods
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			init.body = request.body;
		}

		const response = await fetch(targetUrl, init);

		const responseHeaders = new Headers(response.headers);
		responseHeaders.set('Access-Control-Allow-Origin', '*');
		// Clean hop-by-hop headers to prevent issues in CF Workers
		responseHeaders.delete('transfer-encoding');
		responseHeaders.delete('connection');
		responseHeaders.delete('keep-alive');
		responseHeaders.delete('content-encoding');

		return new Response(response.body, {
			status: response.status,
			headers: responseHeaders,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Internal Server Error';
		console.error(`Proxy request failed: ${message}`);
		return new Response(message, {
			status: 500,
			headers: fixCors({}).headers,
		});
	}
}
