// PXE contract registration.
//
// A wallet's PXE can only simulate against contracts it has been taught
// about. The session that DEPLOYED a contract knows it implicitly, but any
// other session (the Portal, or the Creator after a page reload) must fetch
// the instance from the node and register it together with the artifact --
// otherwise every call fails with "Unknown contract 0x…: add it to PXE".

import type { AztecAddress } from '@aztec/aztec.js/addresses';
import type { AztecNode } from '@aztec/aztec.js/node';

type ContractInstance = NonNullable<Awaited<ReturnType<AztecNode['getContract']>>>;

/** The slice of wallet behaviour the pipeline needs beyond `Wallet`. */
export interface RegistersContracts {
  registerContract(instance: ContractInstance, artifact?: unknown): Promise<unknown>;
}

export async function ensureContractRegistered(
  wallet: RegistersContracts,
  node: AztecNode,
  address: AztecAddress,
  artifact: unknown,
  label: string,
): Promise<void> {
  const instance = await node.getContract(address);
  if (instance === undefined) {
    throw new Error(
      `no contract is deployed at the ${label} address ${address.toString()} -- ` +
        'check the address and that you are on the right network',
    );
  }
  await wallet.registerContract(instance, artifact);
}
