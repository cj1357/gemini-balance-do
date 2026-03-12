import { Hono } from 'hono';
import { handleProxy } from './handler';

export type Env = {
	AUTH_KEY: string;
	API_KEY: string;
};

const app = new Hono<{ Bindings: Env }>();

// 静态资源放行
app.get('/favicon.ico', async (c) => {
	return c.text('Not found', 404);
});

app.get('/robots.txt', async (c) => {
	return c.text('Not found', 404);
});

// 所有请求转发到 proxy handler
app.all('*', async (c) => {
	return handleProxy(c.req.raw, c.env);
});

export default {
	fetch: app.fetch,
};
