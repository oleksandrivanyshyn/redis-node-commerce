import type { CreateItemAttrs } from '$services/types';
import { client } from '$services/redis';
import { serialize } from './serialize';
import { genId } from '$services/utils';
import { itemsKey } from '$services/keys';

export const getItem = async (id: string) => {};

export const getItems = async (ids: string[]) => {};

export const createItem = async (attrs: CreateItemAttrs) => {
  const id = genId();

  const serialized = serialize(attrs);

  await client.hSet(itemsKey(id), serialized);

  return id;
};
