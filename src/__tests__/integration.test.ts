import process from "process"
import { SupabaseClient, createClient } from "@supabase/supabase-js"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { createRxDatabase, RxCollection, RxConflictHandler, RxConflictHandlerInput, RxDatabase, WithDeleted } from "rxdb";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { Human, HUMAN_SCHEMA } from "./test-types.js";
import { replicateSupabase, SupabaseReplicationCheckpoint, SupabaseReplicationOptions } from "../supabase-replication.js";
import { RxReplicationState } from "rxdb/plugins/replication";
import { addRxPlugin } from 'rxdb';
import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';

/**
 * Integration test running against an actual Supabase instance.
 */
// TODO: export schema into .sql file
describe.skipIf(!process.env.TEST_SUPABASE_URL)("replicateSupabase with actual SupabaseClient", () => {
  let supabase: SupabaseClient
  let db: RxDatabase
  let collection: RxCollection<Human>

  beforeAll(() => {
    supabase = createClient(process.env.TEST_SUPABASE_URL!, process.env.TEST_SUPABASE_API_KEY!)
    addRxPlugin(RxDBDevModePlugin);
  })

  beforeEach(async () => {
    // Empty the supabase table.
    const { error } = await supabase.from('humans').delete().neq('id', -1)
    if (error) throw error

    // Create an in-memory RxDB database.
    db = await createRxDatabase({name: 'test', storage: getRxStorageMemory()});
    collection = (await db.addCollections({
      humans: { schema: HUMAN_SCHEMA },
    }))['humans']

    // Start with Alice :)
    await replication({}, async() => {
      // TODO: remove explicit null, should be set by pull anyways
      await collection.insert({id: '1', name: 'Alice', age: null})
    })

    expect(await rxdbContents()).toEqual([{id: '1', name: 'Alice', age: null}])
    expect(await supabaseContents()).toEqual([{id: '1', name: 'Alice', age: null, '_deleted': false}])
  })

  describe("on client-side insertion", () => {
    describe("without conflict", () => {
      it("inserts into supabase", async () => {
        await replication({}, async() => {
          await collection.insert({id: '2', name: 'Bob', age: null})
        })

        expect(await supabaseContents()).toEqual([
          {id: '1', name: 'Alice', age: null, '_deleted': false},
          {id: '2', name: 'Bob', age: null, '_deleted': false}
        ])
      })
    })

    describe("with conflict", () => {
      describe("with default conflict handler", () => {
        it("drops insertion", async () => {
          await supabase.from('humans').insert({id: '2', name: 'Bob'})
          await collection.insert({id: '2', name: 'Bob 2', age: 2})
          await replication()
  
          expect(await supabaseContents()).toEqual([
            {id: '1', name: 'Alice', age: null, '_deleted': false},
            {id: '2', name: 'Bob', age: null, '_deleted': false}
          ])
          expect(await rxdbContents()).toEqual([
            {id: '1', name: 'Alice', age: null},
            {id: '2', name: 'Bob', age: null}
          ])
        })  
      })

      describe("with custom conflict handler", () => {
        it("invokes conflict handler", async () => {
          collection.conflictHandler = resolveConflictWithName('Conflict resolved')

          await supabase.from('humans').insert({id: '2', name: 'Bob'})
          await collection.insert({id: '2', name: 'Bob 2', age: 2})
          await replication()
  
          expect(await supabaseContents()).toEqual([
            {id: '1', name: 'Alice', age: null, '_deleted': false},
            {id: '2', name: 'Conflict resolved', age: 2, '_deleted': false}
          ])
          expect(await rxdbContents()).toEqual([
            {id: '1', name: 'Alice', age: null},
            {id: '2', name: 'Conflict resolved', age: 2}
          ])
        })  
      })      
    })

    describe("on client-side update", () => {
      describe("without conflict", () => {
        it("updates supabase", async () => {
          await replication({}, async() => {
            let doc = await collection.findOne('1').exec()
            await doc!.patch({age: 42})
          })  
          expect(await supabaseContents()).toEqual([
            {id: '1', name: 'Alice', age: 42, '_deleted': false}
          ])
        })
      })    

      describe("with conflict", () => {
        beforeEach(async () => {
          // Set Alice's age to 42 locally, while changing her name on the server.
          let doc = await collection.findOne('1').exec()
          await doc!.patch({age: 42})
          await supabase.from('humans').update({name: 'Alex'}).eq('id', '1')
        })

        describe("with default conflict handler", () => {
          it("applies supabase changes", async () => {
            await replication()
            expect(await rxdbContents()).toEqual([
              {id: '1', name: 'Alex', age: null}
            ])
            expect(await supabaseContents()).toEqual([
              {id: '1', name: 'Alex', age: null, '_deleted': false}
            ])
          })
        })

        describe("with custom conflict handler", () => {
          it("invokes conflict handler", async () => {
            collection.conflictHandler = resolveConflictWithName('Conflict resolved')
            await replication()
            expect(await rxdbContents()).toEqual([
              {id: '1', name: 'Conflict resolved', age: 42}
            ])
            expect(await supabaseContents()).toEqual([
              {id: '1', name: 'Conflict resolved', age: 42, '_deleted': false}
            ])
          })
        })
      })  
    })
  })

  describe("when supabase changed while offline", () => {
    it("pulls new rows", async () => {
      await supabase.from('humans').insert({id: '2', name: 'Bob', age: 42})
      await replication()

      expect(await rxdbContents()).toEqual([
        {id: '1', name: 'Alice', age: null},
        {id: '2', name: 'Bob', age: 42}
      ])
    });
  });

  describe("when supabase changed while online", () => {
    describe("without live replication", () => {
      it("does not pull new rows in realtime", async () => {
        await replication({}, async () => {
          await supabase.from('humans').insert({id: '2', name: 'Bob', age: 42})
        })
  
        expect(await rxdbContents()).toEqual([
          {id: '1', name: 'Alice', age: null}
        ])
      });
    })

    describe("with live replication", () => {
      it("pulls new rows in realtime", async () => {
        await replication({}, async () => {
            await supabase.from('humans').insert({id: '2', name: 'Bob', age: 42})
        })
  
        expect(await rxdbContents()).toEqual([
          {id: '1', name: 'Alice', age: null},
          {id: '2', name: 'Bob', age: 42}
        ])
      });
    })
  });

  let replication = async (options: Partial<SupabaseReplicationOptions<Human>> = {}, transactions: () => Promise<void> = async() => {}): Promise<void> => {
    let replication = startReplication(options)
    await replication.awaitInitialReplication()
    await transactions()
    await replication.awaitInSync()
    await replication.cancel()
  }

  let startReplication = (options: Partial<SupabaseReplicationOptions<Human>> = {}): RxReplicationState<Human, SupabaseReplicationCheckpoint> => {
    let status = replicateSupabase({
      replicationIdentifier: 'test',
      supabaseClient: supabase,
      collection,
      pull: {},
      push: {},
      ...options
    })
    // TODO: Add unit tests for errors thrown by supabse
    status.error$.subscribe(error => {
      console.error(error)
    })
    return status
  }

  let resolveConflictWithName = <T>(name: string): RxConflictHandler<T> => {
    return async (input: RxConflictHandlerInput<T>) => {
      return {
        isEqual: false,
        documentData: {...input.newDocumentState, name}
      }
    }
  }

  let supabaseContents = async (stripModified: boolean = true): Promise<WithDeleted<Human>[]> => {
    const { data, error } = await supabase.from('humans').select().order('id')
    if (error) throw error
    if (stripModified) data.forEach(human => delete human['_modified'])
    return data as WithDeleted<Human>[]
  }

  let rxdbContents = async (): Promise<Human[]> => {
    const results = await collection.find().exec()
    return results.map(doc => doc.toJSON())
  }

  afterEach(async () => {
    await db.remove()
  })
});
