import adapter from '@sveltejs/adapter-node';
import preprocess from 'svelte-preprocess';
import { resolve } from 'path';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: preprocess(),

	kit: {
		floc: true,
		adapter: adapter({ out: 'dist' }),
		prerender: {
			enabled: false
		},
		vite: {
			resolve: {
				alias: {
					$services: resolve('./src/services')
				}
			},
			ssr: {
				noExternal: ['chart.js', 'chartjs-adapter-luxon']
			}
		}
	}
};

export default config;
