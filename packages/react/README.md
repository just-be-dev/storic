# @storic/react

React bindings for [Storic](../../README.md), a schema-versioned datastore
built on Effect. Storic stores entities under explicit schema versions and
uses bidirectional lenses to project data between versions on the fly, so an
app can read and write at whatever version it understands while older or
newer records continue to exist alongside it.

This package wraps the Effect-native `Store` API in idiomatic React: a
provider that owns the `ManagedRuntime`, Suspense-ready read hooks
(`useEntity`, `useEntities`) that stay live as data changes, mutation hooks
with `[run, state]` ergonomics, side-effect-only listener hooks, and escape
hatches for arbitrary `Effect` programs. An optional `/atom` subpath exposes
the same operations as [effect-atom](https://github.com/tim-smart/effect-atom)
factories for apps already built around atoms.

## Installation

```bash
bun add @storic/react @storic/core effect react
```

`@effect/atom-react` is an optional peer dependency. Install it only if you
import from `@storic/react/atom`:

```bash
bun add @effect/atom-react
```

## Setup

Build a `ManagedRuntime` whose layer provides `Store`, then mount
`<StoricProvider>` near the root of your tree.

```tsx
import { ManagedRuntime } from "effect";
import { StoricProvider } from "@storic/react";
import { StoreLive } from "./store";

const runtime = ManagedRuntime.make(StoreLive);

export function Root() {
  return (
    <StoricProvider runtime={runtime} fallback={<Loading />}>
      <App />
    </StoricProvider>
  );
}
```

The provider resolves `Store` from the runtime once and exposes it (plus the
runtime) via context. Layer-construction failures are logged to `console.warn`
— if you need structured handling, resolve `Store` yourself before mounting.

## Read hooks

`useEntity` and `useEntities` **suspend on first render** and stay **live**
afterwards: any mutation that affects the read re-renders the component.
Wrap consumers in `<Suspense>` and `<ErrorBoundary>`.

```tsx
import { Suspense } from "react";
import { useEntity, useEntities } from "@storic/react";
import { Person } from "./schemas";

function PersonView({ id }: { id: string }) {
  const person = useEntity(Person, id); // EntityRecord<Person> | null
  if (!person) return <NotFound />;
  return <h1>{person.data.fullName}</h1>;
}

function PeopleList() {
  const people = useEntities(Person, {
    filters: [{ field: "active", op: "eq", value: true }],
    limit: 50,
  });
  return <ul>{people.map((p) => <li key={p.id}>{p.data.fullName}</li>)}</ul>;
}

<Suspense fallback={<Spinner />}>
  <PeopleList />
</Suspense>
```

Pass `opts.as` to project the result through a lens to a different schema
version:

```ts
const v1 = useEntity(Person, id, { as: PersonV1 });
```

## Mutation hooks

Each mutation hook returns `[run, state]`. `run` is a stable callback that
returns a `Promise`; `state` is `{ status, data, error }`.

```tsx
import { useSaveEntity, useUpdateEntity, useDeleteEntity } from "@storic/react";

function NewPersonForm() {
  const [save, save$] = useSaveEntity(Person);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        await save({ fullName: "Ada", email: "ada@example.com" });
      }}
    >
      {save$.status === "error" && <Err error={save$.error} />}
      <button disabled={save$.status === "pending"}>Save</button>
    </form>
  );
}
```

Available mutations:

- `useSaveEntity(entity)` — insert or replace
- `useUpdateEntity(entity)` — `merge` (default) or `replace`
- `usePatchEntities(entity)` — bulk patch matching a filter set
- `useDeleteEntity()` — delete by id

All accept an optional `as` schema for lens projection.

## Listener hooks

Subscribe to changes **without** re-rendering. Useful for syncing entity
state to URLs, analytics, external sockets, etc. `onChange` is captured by
ref, so inline callbacks are safe.

```tsx
import { useEntityListener, useEntitiesListener } from "@storic/react";

useEntityListener(Person, id, (record) => {
  analytics.track("person.changed", { id, version: record?.version });
});

useEntitiesListener(Person, { filters }, (records) => {
  socket.send({ kind: "people", records });
});
```

## Effect escape hatches

For arbitrary `Effect<A, E, Store>` programs:

```tsx
import { useEffectQuery, useEffectCallback } from "@storic/react";

function CustomQuery({ id }: { id: string }) {
  const { data, error, isLoading } = useEffectQuery(
    Effect.gen(function* () {
      const store = yield* Store;
      return yield* customLogic(store, id);
    }),
    [id],
  );
  // ...
}
```

`useEffectCallback` mirrors the mutation-hook shape for on-demand effects.

## Atom bindings (optional)

If your app already uses `@effect/atom-react`, the `/atom` subpath exposes
factories that build atoms backed by the same Store. Atoms participate in
the atom registry's dependency tracking and idle GC.

```ts
import * as Atom from "effect/unstable/reactivity/Atom";
import { useAtomSuspense, useAtomSet } from "@effect/atom-react";
import {
  entityAtom,
  entitiesAtom,
  saveEntityAtom,
  updateEntityAtom,
  patchEntitiesAtom,
  deleteEntityAtom,
} from "@storic/react/atom";

const runtime = Atom.runtime(StoreLive);
const personById = entityAtom(runtime, Person);
const savePerson = saveEntityAtom(runtime, Person);

function PersonView({ id }: { id: string }) {
  const result = useAtomSuspense(personById(id));
  const save = useAtomSet(savePerson, { mode: "promise" });
  // result.value: EntityRecord<Person> | null
}
```

> `effect/unstable/reactivity/Atom` is an unstable Effect API and may change
> across minor releases. Pin `effect` carefully when using this entry.

## Exports

| Entry | Members |
| --- | --- |
| `@storic/react` | `StoricProvider`, `useStoricStore`, `useStoricRuntime`, `useEntity`, `useEntities`, `useSaveEntity`, `useUpdateEntity`, `usePatchEntities`, `useDeleteEntity`, `useEntityListener`, `useEntitiesListener`, `useEffectQuery`, `useEffectCallback` |
| `@storic/react/atom` | `entityAtom`, `entitiesAtom`, `saveEntityAtom`, `updateEntityAtom`, `patchEntitiesAtom`, `deleteEntityAtom` |

## License

MIT
