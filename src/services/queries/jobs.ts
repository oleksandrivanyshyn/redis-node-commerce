import { client } from '$services/redis';
import { jobsDelayedKey } from '$services/keys';
import { genId } from '$services/utils';

export const addJob = async (name: string, runAt: number, args: any) => {
  await client.zAdd(jobsDelayedKey(), {
    value: JSON.stringify({ id: genId(), name, args }),
    score: runAt,
  });
};
