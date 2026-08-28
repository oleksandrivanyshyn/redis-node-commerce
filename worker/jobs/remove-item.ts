import type { Client } from '../types';
import {
	itemsKey,
	itemsViewsKey,
	itemsByViewsKey,
	itemsByPriceKey,
	itemsByEndingAtKey,
	bidHistoryKey
} from '../../src/services/keys';

export const removeItem = async (client: Client, args: { itemId?: string }) => {
	const itemId = args && args.itemId;

	if (!itemId) {
		throw new Error('removeItem requires an itemId');
	}

	await Promise.all([
		client.del([itemsKey(itemId), itemsViewsKey(itemId), bidHistoryKey(itemId)]),
		client.zRem(itemsByViewsKey(), itemId),
		client.zRem(itemsByPriceKey(), itemId),
		client.zRem(itemsByEndingAtKey(), itemId)
	]);

	return { removed: itemId };
};
