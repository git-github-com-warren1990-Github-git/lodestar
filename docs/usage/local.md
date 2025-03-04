# Local testnet

To quickly test and run Lodestar we recommend starting a local testnet. We recommend a simple configuration of two beacon nodes with multiple validators

**Terminal 1**

Run a beacon node, with 8 validators with the following command.

```bash
./lodestar dev --genesisValidators 8 --genesisTime 1578787200 --enr.ip 127.0.0.1 --rootDir </path/to/node1> --reset
```

`--genesisValidators` and `--genesisTime` define the genesis state of the beacon chain. `--rootDir` defines a path where
lodestar should store the beacon state, `--enr.ip` sets the enr ip entry for the node while the `--reset` flag ensures the state is cleared on each restart - which is useful when testing locally.

Once the node has started, make a request to `curl http://localhost:9596/eth/v1/node/identity` and copy the `enr` value.

This would be used to connect from the second node.

> enr stands for ethereum node records, which is a format for conveying p2p connectivity information for ethereum nodes.
> For more info see [eip-778](https://eips.ethereum.org/EIPS/eip-778)

**Terminal 2**

Start the second node without starting any validators and connect to the first node by supplying the copied `enr` value:

```bash
./lodestar dev --startValidators 0:0 \
  --genesisValidators 8 --genesisTime 1578787200 \
  --rootDir /path/to/node2 \
  --port 9001 \
  --api.rest.port 9597 \
  --network.connectToDiscv5Bootnodes true \
  --network.discv5.bootEnrs <enr value>
  --reset
```

By default, lodestar starts as many validators as the number supplied by `--genesisValidators`. In other to not start any validator, this is overridden by
the `--startValidators` option. Passing a value of `0:0` means no validators should be started.

Also, take note that the values of `--genesisValidators` and `--genesisTime` must be the same as the ones passed to the first node in other for the two nodes
to have the same beacon chain.

Finally `--port` and `--api.rest.port` are supplied since the default values will already be in use by the first node.

The `--network.connectToDiscv5Bootnodes` flags needs to be set to true as this is needed to allow connection to boot enrs on local devnet.
The exact enr of node to connect to is then supplied via the `--network.discv5.bootEnrs` flag.

Once the second node starts, you should see an output similar to the following in either of the terminals:

```
Eph 167991/6 6.007 []  info: Searching peers - peers: 1 - slot: 5375718 (skipped 5375718) - head: 0 0xcc67…3345 - finalized: 0x0000…0000:0
```

For further confirmation that both nodes are connected as peers, make a request to the `/eth/v1/node/peers` endpoint.

For example, making the request on the first node via the following command:

`curl http://localhost:9596/eth/v1/node/peers | jq`

will give a result similar to the following:

```

{
  "data": [
    {
      "peer_id": "...",
      "enr": "",
      "last_seen_p2p_address": "....",
      "direction": "inbound",
      "state": "connected"
    }
  ],
  "meta": {
    "count": 1
  }
}
```
