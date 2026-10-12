/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Helpers to mock D-Bus services in Linux xpcshell tests with python-dbusmock.
 * Tests using this need `tags = "portal"` so that `mach test` installs
 * testing/xpcshell/linux_portal_requirements.txt.
 */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  TestUtils: "resource://testing-common/TestUtils.sys.mjs",
});

const MOCK_INTERFACE = "org.freedesktop.DBus.Mock";

let gGdbus = null;

async function gdbus() {
  gGdbus ??= await lazy.Subprocess.pathSearch("gdbus");
  return gGdbus;
}

async function readAll(aPipe) {
  let data = "";
  let chunk;
  while ((chunk = await aPipe.readString())) {
    data += chunk;
  }
  return data;
}

/**
 * A python-dbusmock instance owning a bus name on a private bus.
 */
class DBusMock {
  #process;

  /**
   * @param {string} aAddress Address of the bus the mock is on.
   * @param {string} aBusName Bus name owned by the mock.
   * @param {string} aObjectPath Path of the main mock object.
   * @param {Subprocess} aProcess The dbusmock process.
   */
  constructor(aAddress, aBusName, aObjectPath, aProcess) {
    this.address = aAddress;
    this.busName = aBusName;
    this.objectPath = aObjectPath;
    this.#process = aProcess;
  }

  /**
   * Calls a D-Bus method on the mocked service with gdbus.
   *
   * @param {string} aObjectPath
   * @param {string} aMethod Fully qualified method name.
   * @param {string[]} aArgs Arguments in GVariant text format.
   * @returns {Promise<{exitCode: number, stdout: string}>}
   */
  async call(aObjectPath, aMethod, aArgs = []) {
    const proc = await lazy.Subprocess.call({
      command: await gdbus(),
      arguments: [
        "call",
        "--address",
        this.address,
        "-d",
        this.busName,
        "-o",
        aObjectPath,
        "-m",
        aMethod,
        ...aArgs,
      ],
    });
    const stdout = await readAll(proc.stdout);
    const { exitCode } = await proc.wait();
    return { exitCode, stdout };
  }

  /**
   * Calls a method of the org.freedesktop.DBus.Mock interface.
   *
   * @param {string} aMethod Method name, e.g. "AddObject".
   * @param {string[]} aArgs Arguments in GVariant text format.
   * @param {string} [aObjectPath] Defaults to the main mock object.
   */
  mockCall(aMethod, aArgs = [], aObjectPath = this.objectPath) {
    return this.call(aObjectPath, `${MOCK_INTERFACE}.${aMethod}`, aArgs);
  }

  /**
   * Waits until the mock exports aInterfaceName at aObjectPath.
   *
   * @param {string} aObjectPath
   * @param {string} aInterfaceName
   */
  async waitForObject(aObjectPath, aInterfaceName) {
    await lazy.TestUtils.waitForCondition(async () => {
      const proc = await lazy.Subprocess.call({
        command: await gdbus(),
        arguments: [
          "introspect",
          "--address",
          this.address,
          "-d",
          this.busName,
          "-o",
          aObjectPath,
        ],
      });
      const stdout = await readAll(proc.stdout);
      const { exitCode } = await proc.wait();
      return exitCode == 0 && stdout.includes(`interface ${aInterfaceName} {`);
    }, `Waiting for ${aInterfaceName} at ${aObjectPath}`);
  }

  async stop() {
    await this.mockCall("Reset");
    await this.#process.kill();
  }
}

async function readLine(aPipe) {
  let data = "";
  while (!data.includes("\n")) {
    const chunk = await aPipe.readString();
    if (!chunk) {
      break;
    }
    data += chunk;
  }
  return data.split("\n")[0].trim();
}

export const DBusMockTestUtils = {
  /**
   * Starts a private bus and points DBUS_SESSION_BUS_ADDRESS at it, before
   * anything connects to the session bus. The daemon is stopped once xpcshell
   * has exited, since GLib exits when its bus goes away.
   *
   * @returns {Promise<string>} The address of the bus.
   */
  async startBus() {
    const address = `unix:abstract=firefox-xpcshell-dbus-${Services.uuid.generateUUID().toString().slice(1, -1)}`;
    const daemon = await lazy.Subprocess.call({
      command: await lazy.Subprocess.pathSearch("sh"),
      arguments: [
        "-c",
        'dbus-daemon --session --nofork --address="$1" --print-address=1 & tail --pid=$PPID -f /dev/null; kill $!',
        "sh",
        address,
      ],
    });
    const listening = await readLine(daemon.stdout);
    if (!listening) {
      throw new Error(`dbus-daemon failed to listen on ${address}`);
    }
    Services.env.set("DBUS_SESSION_BUS_ADDRESS", listening);
    return listening;
  },

  /**
   * Starts python-dbusmock on a bus from startBus() and waits until it owns
   * aBusName.
   *
   * @param {object} aOptions
   * @param {string} aOptions.address Address returned by startBus().
   * @param {string} aOptions.busName
   * @param {string} aOptions.objectPath Path of the main mock object.
   * @param {string} aOptions.interfaceName Interface of the main mock object.
   * @returns {Promise<DBusMock>}
   */
  async startMock({ address, busName, objectPath, interfaceName }) {
    const proc = await lazy.Subprocess.call({
      command: await lazy.Subprocess.pathSearch("python3"),
      arguments: ["-m", "dbusmock", busName, objectPath, interfaceName],
    });

    const mock = new DBusMock(address, busName, objectPath, proc);
    await lazy.TestUtils.waitForCondition(
      async () => (await mock.mockCall("GetCalls")).exitCode == 0,
      `Waiting for dbusmock to own ${busName}`
    );
    return mock;
  },
};
