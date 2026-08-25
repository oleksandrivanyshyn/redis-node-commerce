import { createClient } from 'redis';

const client = createClient({
	socket: {
		host: process.env.REDIS_HOST || 'localhost',
		port: parseInt(process.env.REDIS_PORT || '6379')
	},
	...(process.env.REDIS_PW ? { password: process.env.REDIS_PW } : {})
});

client.on('error', (err) => console.error(err));
client.connect();

export { client };