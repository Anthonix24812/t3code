import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettingsModule from "../serverSettings.ts";

const layerServerSettings = ServerSettingsModule.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-sandbox-settings-test-" })),
  ),
);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("sandbox settings", (it) => {
  it.effect("keeps the Boat key in the secret store across partial sandbox edits", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const key = "boat_live_sentinel_key";

      yield* service.updateSettings({ sandbox: { boatApiKey: key } });
      // The settings UI saves size and idle minutes on their own.
      yield* service.updateSettings({ sandbox: { size: "large" } });
      yield* service.updateSettings({ sandbox: { idleMinutes: 5 } });

      const settings = yield* service.getSettings;
      assert.deepEqual(settings.sandbox, {
        boatApiKey: key,
        size: "large",
        idleMinutes: 5,
        maxConcurrentVms: 4,
        copyHostLogins: false,
      });
      assert.notInclude(yield* fs.readFileString(config.settingsPath), key);
      const forClient = ServerSettingsModule.redactServerSettingsForClient(settings, {
        secretReferences: true,
      });
      assert.notInclude(JSON.stringify(forClient), key);
    }).pipe(Effect.provide(layerServerSettings)),
  );
});
