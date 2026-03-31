export default function PvmContractPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-green-400">
        PVM Counter (resolc)
      </h1>
      <p className="text-gray-400">
        Interact with the same Solidity counter compiled with{" "}
        <code className="bg-gray-800 px-1 rounded">resolc</code> to PolkaVM
        (RISC-V) bytecode, deployed via pallet-revive. Uses{" "}
        <code className="bg-gray-800 px-1 rounded">
          @parity/hardhat-polkadot
        </code>{" "}
        for the PVM toolchain.
      </p>

      <div className="bg-gray-900 rounded-lg p-5 border border-gray-800 space-y-4">
        <div className="text-gray-400 text-sm space-y-2">
          <p>To deploy and interact with the PVM counter:</p>
          <ol className="list-decimal list-inside space-y-1">
            <li>
              <code className="bg-gray-800 px-1 rounded">
                cd contracts/pvm && npm install
              </code>
            </li>
            <li>
              <code className="bg-gray-800 px-1 rounded">
                npx hardhat compile
              </code>{" "}
              (compiles via resolc to PolkaVM bytecode)
            </li>
            <li>
              Deploy to testnet:{" "}
              <code className="bg-gray-800 px-1 rounded">
                npx hardhat ignition deploy ./ignition/modules/Counter.js
                --network polkadotTestnet
              </code>
            </li>
          </ol>
          <p className="mt-3">
            Same Solidity source (
            <code className="bg-gray-800 px-1 rounded">
              contracts/solidity/Counter.sol
            </code>
            ), different compiler and VM target.
          </p>
        </div>

        <div>
          <label className="text-sm text-gray-400 block mb-1">
            Contract Address
          </label>
          <input
            type="text"
            placeholder="0x..."
            className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white w-full"
          />
        </div>

        <div className="flex gap-3">
          <button className="px-4 py-2 bg-green-600 hover:bg-green-700 rounded text-white text-sm opacity-50 cursor-not-allowed">
            Query Counter
          </button>
          <button className="px-4 py-2 bg-green-600 hover:bg-green-700 rounded text-white text-sm opacity-50 cursor-not-allowed">
            Set Counter
          </button>
          <button className="px-4 py-2 bg-green-600 hover:bg-green-700 rounded text-white text-sm opacity-50 cursor-not-allowed">
            Increment
          </button>
        </div>
      </div>
    </div>
  );
}
