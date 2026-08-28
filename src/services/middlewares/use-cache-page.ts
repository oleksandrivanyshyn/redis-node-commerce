import type { Handle } from '@sveltejs/kit';
import {
  cacheableRoutes,
  getCachedPage,
  setCachedPage,
} from '$services/queries/page-cache';
import { streamToString } from '$lib/util/stream-to-string';

export const useCachePage: Handle = async ({ event, resolve }) => {
  if (
    event.request.method !== 'GET' ||
    !cacheableRoutes.includes(event.url.pathname)
  ) {
    return resolve(event);
  }

  const page = await getCachedPage(event.url.pathname);

  if (page) {
    return new Response(page, {
      headers: {
        'content-type': 'text/html',
      },
    });
  }

  event.request.headers.set('if-none-match', Math.random().toString());
  const res = await resolve(event);

  if (!res.body) {
    return res;
  }

  const body = await streamToString(res.clone().body);
  await setCachedPage(event.url.pathname, body);

  return res;
};
