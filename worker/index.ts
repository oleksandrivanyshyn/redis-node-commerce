import 'dotenv/config';
import { client } from './client';
import { removeItem } from './jobs/remove-item';
import type { CompletedJobSpec, ErroredJobSpec, JobSpec, Keys, TaskMap, WrappedMessage } from './types';
import {
	jobsGroupName,
	jobsDelayedKey,
	jobsActiveKey,
	jobsFailedKey,
	jobsCompletedKey
} from '../src/services/keys';

const keys: Keys = {
	groupName: jobsGroupName(),
	delayedKey: jobsDelayedKey(),
	activeKey: jobsActiveKey(),
	failedKey: jobsFailedKey(),
	completedKey: jobsCompletedKey()
};

const tasks: TaskMap = {
	removeItem
};

const consumerName = `worker-${process.pid}`;
const pollIntervalMs = 1000;

let running = true;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const createGroup = async () => {
	try {
		await client.xGroupCreate(keys.activeKey, keys.groupName, '$', { MKSTREAM: true });
	} catch (err) {
		if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) {
			throw err;
		}
	}
};

const promoteDelayedJobs = async () => {
	const due = await client.zRangeByScore(keys.delayedKey, '-inf', Date.now());

	for (const entry of due) {
		const claimed = await client.zRem(keys.delayedKey, entry);

		if (!claimed) {
			continue;
		}

		const { name, args } = JSON.parse(entry);

		await client.xAdd(keys.activeKey, '*', {
			name,
			args: JSON.stringify(args ?? null),
			retries: '0'
		});
	}
};

const toJobSpec = (message: WrappedMessage): JobSpec => ({
	messageId: message.id,
	name: message.message.name,
	args: JSON.parse(message.message.args || 'null'),
	retries: parseInt(message.message.retries || '0')
});

const runJob = async (message: WrappedMessage) => {
	const spec = toJobSpec(message);
	const task = tasks[spec.name];

	if (!task) {
		const failed: ErroredJobSpec = { ...spec, err: `Unknown job "${spec.name}"` };
		await client.lPush(keys.failedKey, JSON.stringify(failed));
		await client.xAck(keys.activeKey, keys.groupName, spec.messageId);
		console.error(failed.err);
		return;
	}

	try {
		const result = await task(client, spec.args);
		const completed: CompletedJobSpec = { ...spec, result: JSON.stringify(result ?? null) };
		await client.lPush(keys.completedKey, JSON.stringify(completed));
		console.log(`${spec.name} ${spec.messageId} completed`);
	} catch (err) {
		const failed: ErroredJobSpec = { ...spec, err: err instanceof Error ? err.message : String(err) };
		await client.lPush(keys.failedKey, JSON.stringify(failed));
		console.error(`${spec.name} ${spec.messageId} failed: ${failed.err}`);
	} finally {
		await client.xAck(keys.activeKey, keys.groupName, spec.messageId);
	}
};

const readActiveJobs = async () => {
	const streams = await client.xReadGroup(
		keys.groupName,
		consumerName,
		{ key: keys.activeKey, id: '>' },
		{ COUNT: 10 }
	);

	if (!streams) {
		return 0;
	}

	let handled = 0;

	for (const stream of streams) {
		for (const message of stream.messages) {
			await runJob(message as WrappedMessage);
			handled++;
		}
	}

	return handled;
};

const shutdown = async () => {
	if (!running) {
		return;
	}

	running = false;
	await client.quit();
	console.log('Worker stopped');
};

const run = async () => {
	await client.connect();
	await createGroup();

	console.log(`${consumerName} listening for jobs on "${keys.activeKey}"`);

	while (running) {
		try {
			await promoteDelayedJobs();
			const handled = await readActiveJobs();

			if (!handled) {
				await pause(pollIntervalMs);
			}
		} catch (err) {
			console.error(err);
			await pause(pollIntervalMs);
		}
	}
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

run();
