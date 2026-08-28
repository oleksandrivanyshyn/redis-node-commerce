# rbay — auction marketplace on Redis

An eBay-style auction app where **Redis is the only database**. There is no
Postgres, no Mongo, no ORM: users, items, bids, sessions, likes, view counts,
the search index and even the HTML page cache all live in Redis, each one
modelled with the data structure that fits it best.

Built with [SvelteKit](https://kit.svelte.dev) (SSR + endpoints), TypeScript,
Tailwind CSS and [`node-redis` v4](https://github.com/redis/node-redis) against
a `redis-stack` server (Redis + RediSearch).

---

## Table of contents

- [Features](#features)
- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [npm scripts](#npm-scripts)
- [Redis data model](#redis-data-model)
- [How the interesting parts work](#how-the-interesting-parts-work)
- [Project structure](#project-structure)
- [Load testing bids](#load-testing-bids)
- [Known gaps](#known-gaps)

---

## Features

| Feature                                                | Redis mechanics behind it                                                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Sign up / sign in                                      | hashes for users, a set for unique usernames, a sorted set as a username → id lookup, `scrypt` password hashing |
| Sessions                                               | session hashes + a `keygrip`-signed `auth` cookie                                                               |
| Create and browse items                                | hashes for items, sorted sets for every leaderboard                                                             |
| "Ending soonest", "Most viewed", "Highest price" feeds | `ZRANGE BYSCORE` and `SORT ... BY nosort GET` to fetch whole items in one round trip                            |
| Unique view counter                                    | HyperLogLog per item, incremented from a Lua script                                                             |
| Likes and "items you both liked"                       | sets per user + `SINTER`                                                                                        |
| Bidding                                                | a distributed lock (`SET NX PX` + token) around read-validate-write                                             |
| Bid history                                            | a list per item, `LRANGE` from the tail for pagination                                                          |
| Full-text search + owner filter + sorting              | a RediSearch index over the `items#*` hashes                                                                    |
| Static page cache                                      | cached HTML strings with a short TTL, served from a middleware                                                  |

## Quick start

**Requirements:** Node.js 16+ and Docker (or any reachable Redis Stack server).

```bash
# 1. start Redis Stack (Redis + RediSearch + RedisInsight)
docker compose up -d

# 2. install dependencies
npm install

# 3. create .env (see below)
printf 'REDIS_HOST=localhost\nREDIS_PORT=6379\nREDIS_PW=\n' > .env

# 4. load demo users, items and bids
npm run seed

# 5. run the dev server
npm run dev
```

The app is on <http://localhost:3000>, and RedisInsight — a GUI for browsing the
keys you are about to create — on <http://localhost:8001>.

> ⚠️ `npm run seed` calls `FLUSHALL` first. Never point it at a Redis instance
> that holds anything you care about.

Seeded users are stored with an empty password, so you cannot sign in as them —
create your own account on `/auth/signup` to bid and like.

## Environment variables

`.env` is git-ignored. It is read by `dotenv` in `src/hooks.ts`, the seeder and
the CLI wrapper; the app refuses to boot without `REDIS_HOST`.

| Variable     | Required | Default   | Purpose                                                             |
| ------------ | -------- | --------- | ------------------------------------------------------------------- |
| `REDIS_HOST` | yes      | —         | Redis hostname                                                      |
| `REDIS_PORT` | no       | `6379`    | Redis port                                                          |
| `REDIS_PW`   | no       | —         | password; leave empty for the local Docker server                   |
| `COOKIE_KEY` | no       | `alskdjf` | key used to sign session cookies — set a real one outside local dev |

## npm scripts

| Script                              | What it does                                                      |
| ----------------------------------- | ----------------------------------------------------------------- |
| `npm run dev`                       | SvelteKit dev server on port 3000                                 |
| `npm run build` / `npm run preview` | production build into `dist/` (node adapter) and a preview server |
| `npm run seed`                      | **flushes** Redis and reloads `seeds/content.json`                |
| `npm run cli`                       | `redis-cli` already pointed at the server from `.env`             |
| `npm run sandbox`                   | scratch file (`sandbox/index.ts`) for trying commands out         |
| `npm run sandbox:bids`              | bid stress test, see [Load testing bids](#load-testing-bids)      |
| `npm run check`                     | `svelte-check` type checking                                      |
| `npm run lint` / `npm run format`   | Prettier check / write                                            |

## Redis data model

Every key name is produced by a helper in [`src/services/keys.ts`](src/services/keys.ts),
so the key layout is readable in one file instead of being scattered through queries.

| Key                    | Type             | Holds                                                                                                            |
| ---------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `items#<itemId>`       | hash             | one item: name, description, imageUrl, ownerId, price, views, likes, bids, createdAt, endingAt, highestBidUserId |
| `items:views`          | sorted set       | itemId → view count                                                                                              |
| `items:price`          | sorted set       | itemId → current highest bid                                                                                     |
| `items:endingAt`       | sorted set       | itemId → auction end timestamp                                                                                   |
| `items:views#<itemId>` | HyperLogLog      | distinct user ids that viewed the item                                                                           |
| `history#<itemId>`     | list             | bids as `amount:createdAt`, newest pushed to the tail                                                            |
| `idx:items`            | RediSearch index | index over all `items#*` hashes                                                                                  |
| `users#<userId>`       | hash             | username + salted password hash                                                                                  |
| `usernames`            | sorted set       | username → numeric user id (id lookup by exact username)                                                         |
| `usernames:unique`     | set              | every taken username, for O(1) uniqueness checks                                                                 |
| `users:likes#<userId>` | set              | item ids the user liked                                                                                          |
| `sessions#<sessionId>` | hash             | userId + username                                                                                                |
| `pagecache#<route>`    | string           | rendered HTML, 2 s TTL                                                                                           |
| `lock:<itemId>`        | string           | distributed lock token, 2 s TTL                                                                                  |

## How the interesting parts work

### Bidding under a distributed lock

Placing a bid is a read-validate-write sequence (`src/services/queries/bids.ts`),
which is exactly the shape that breaks under concurrency: two bidders read the
same price and both "win". [`withLock`](src/services/redis/lock.ts) wraps it:

- acquire with `SET lock:<itemId> <random token> NX PX 2000`, retrying up to
  20 times with a 100 ms pause;
- release with a Lua script that deletes the key **only if the stored token is
  still ours** — so a lock that already expired and was taken by someone else is
  never deleted by the previous holder;
- the callback gets a `signal.expired` flag and a `Proxy`-wrapped client that
  throws as soon as the lock's lifetime has elapsed, so a slow request cannot
  write with a lock it no longer holds.

`sandbox/bid-stress.ts` exists to prove the lock does its job.

### Counting unique views atomically

A view has to update three keys at once: the HyperLogLog of viewers, the item's
`views` field, and the `items:views` leaderboard — but only when the viewer is
new. Doing that from Node would be three round trips and a race, so it is a Lua
script registered on the client (`incrementView` in
[`src/services/redis/client.ts`](src/services/redis/client.ts)): `PFADD` returns
whether the user was actually inserted, and the `HINCRBY` / `ZINCRBY` only run
when it did.

### Fetching feeds in a single round trip

`itemsByViews` and `itemsByPrice` avoid the classic N+1 (`ZRANGE`, then one
`HGETALL` per id) by using `SORT` with `BY nosort` and `GET` patterns — Redis
walks the sorted set and returns the item fields for every id in one reply, which
the query then unflattens into objects.

### Search

`createIndexes` builds `idx:items` on boot (skipping it if it already exists)
over the `items#` hash prefix: `name` and `description` as TEXT, `ownerId` as
TAG, and the numeric fields sortable. Two queries use it — user-facing search
with fuzzy terms and a 5× weight on name matches, and the seller dashboard,
which filters by `@ownerId:{...}` and sorts/paginates server-side.

### Middlewares

`src/hooks.ts` composes three handlers with SvelteKit's `sequence`:
`useErrors` (turns a thrown error into a 500 JSON body) → `useCachePage`
(serves and stores rendered HTML for a small allow-list of static routes) →
`useSession` (reads the signed cookie, loads or creates the session hash,
writes it back after the response).

## Project structure

```
src/
  hooks.ts                  # dotenv, redis boot, middleware chain, session
  lib/                      # Svelte components and small client-side helpers
  routes/                   # pages (.svelte) + endpoints (.ts)
  services/
    keys.ts                 # every Redis key name in one place
    types.ts                # Item, User, Bid, Session
    auth/                   # scrypt hashing, signup/signin
    middlewares/            # errors, page cache, session
    queries/                # all Redis access, grouped by domain
      items/                # crud, feeds, search, (de)serialization, status
    redis/
      client.ts             # client + Lua scripts
      create-indexes.ts     # RediSearch index definition
      lock.ts               # withLock
    utils/                  # id generation, hashing, image urls
seeds/                      # demo data loader (flushes the DB)
sandbox/                    # scratch scripts, bid stress test
worker/                     # background job scaffolding (WIP)
cli/                        # redis-cli preconfigured from .env
```

## Load testing bids

`sandbox/bid-stress.ts` fires 50 concurrent bids at one item and prints how many
succeeded. It expects an auth cookie and an item id:

1. sign in, open an item page, and copy the `auth` cookie from
   DevTools → Application → Cookies and the id from the `/items/<id>` URL;
2. run it:

```bash
AUCTION_COOKIE='auth=<value>' AUCTION_ITEM_ID='<id>' npm run sandbox:bids
```

By default it round-robins requests across ports 3000/3001/3002 to simulate
several app instances behind a load balancer — start extra instances (e.g. with
`pm2`, which is already a dependency) or edit the port list to run against a
single dev server.

## Known gaps

This is a learning project and a few pieces are deliberately still scaffolding:

- `npm run worker` points at `worker/index.ts`, which does not exist yet;
  `worker/jobs/remove-item.ts` and `src/services/queries/jobs.ts` are stubs.
- `getSimilarItems` (`src/services/queries/items/similar.ts`) is unimplemented.
- `src/routes/index.ts` imports `itemsByBids` / `itemsByLikes`, which are not
  exported yet (the values are unused).
