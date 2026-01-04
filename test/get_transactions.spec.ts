import {CKB_LIGHT_RPC_URL, lightClientRPC, rpcCLient} from "../config/config";
import {HexNumber, Script} from "@ckb-lumos/base";
import {ScriptType} from "@ckb-lumos/light-client/src/type";
import {waitScriptsUpdate} from "../service/lightService";
import {BI} from "@ckb-lumos/bi";
import {expect} from "chai";

type TestLightClientScript = {
    script: Script;
    scriptType: ScriptType;
};
describe('get_transactions', function () {
    this.timeout(30 * 60_000)
    let test_scripts: TestLightClientScript[] = [
        {
            "script": {
                "codeHash": "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
                "hashType": "type",
                "args": "0xef0273afa67242b1b407eced450f78b2c02a2a23"
            },
            "scriptType": "lock",
        }
    ]
    before(async function () {

        let txs = await rpcCLient.getTransactions({
            "script": test_scripts[0].script, "scriptType": test_scripts[0].scriptType,
            "groupByTransaction": true
        }, "asc", "0xff")
        console.log(txs.objects[0].blockNumber)
        console.log(txs.objects[txs.objects.length - 1].blockNumber)
        await lightClientRPC.setScripts([
            {
                "script": test_scripts[0].script,
                "scriptType": test_scripts[0].scriptType,
                "blockNumber": BI.from(12112687).sub(1).toHexString()
            }
        ])
        await waitScriptsUpdate(BI.from(12116260),CKB_LIGHT_RPC_URL)
    })

    it("groupByTransaction:false", async () => {
        let lightAfterCursor = undefined;
        let ckbAfterCursor = undefined;
        while (lightAfterCursor != "0x") {
            let lightTxs = await lightClientRPC.getTransactions(
                {
                    "script": test_scripts[0].script,
                    "scriptType": test_scripts[0].scriptType,
                    // "groupByTransaction": true
                    filter: {
                        blockRange: [BI.from(12112687).sub(1).toHexString(), BI.from(12116260).toHexString()],
                    }
                }, "asc", "0x1ff", lightAfterCursor
            )
            let ckbTxs = await rpcCLient.getTransactions({
                "script": test_scripts[0].script, "scriptType": test_scripts[0].scriptType,
                // "groupByTransaction": true
                filter: {
                    blockRange: [BI.from(12112687).sub(1).toHexString(), BI.from(12116260).toHexString()],
                }
            }, "asc", "0x1ff", ckbAfterCursor)

            console.log("lightTxs.objects.length:", lightTxs.objects.length)
            console.log("ckbTxs.objects.length:", ckbTxs.objects.length)
            expect(lightTxs.objects.length == ckbTxs.objects.length, "light txs length not equal ckb txs length")
            for (let i = 0; i < lightTxs.objects.length; i++) {
                let lightTx = lightTxs.objects[i]
                let ckbTx = ckbTxs.objects[i]
                // console.log("lightTx:", lightTx)
                // console.log("ckbTx:", ckbTx)
                expect(lightTx.transaction.hash == ckbTx.txHash, "light tx hash not equal ckb tx hash")
                expect(lightTx.blockNumber == ckbTx.blockNumber, "light block number not equal ckb tx hash")
                expect(lightTx.ioIndex == ckbTx.ioIndex, "light block number not equal ckb tx hash")
                expect(lightTx.txIndex == ckbTx.txIndex, "light block number not equal ckb tx hash")
            }
            lightAfterCursor = lightTxs.lastCursor
            ckbAfterCursor = ckbTxs.lastCursor
            console.log("lightAfterCursor:", lightAfterCursor)

        }
    })

    it("groupByTransaction:true", async () => {
        let lightAfterCursor = undefined;
        let ckbAfterCursor = undefined;
        while (lightAfterCursor != "0x") {
            let lightTxs = await lightClientRPC.getTransactions(
                {
                    "script": test_scripts[0].script,
                    "scriptType": test_scripts[0].scriptType,
                    "groupByTransaction": true,
                    filter: {
                        blockRange: [BI.from(12112687).sub(1).toHexString(), BI.from(12116260).toHexString()],
                    }
                }, "asc", BI.from(1000).toHexString(), lightAfterCursor
            )
            if(lightTxs.objects.length == 0){
                return
            }

            let ckbTxs = await rpcCLient.getTransactions({
                "script": test_scripts[0].script, "scriptType": test_scripts[0].scriptType,
                "groupByTransaction": true,
                filter: {
                    blockRange: [BI.from(12112687).sub(1).toHexString(), BI.from(12116260).toHexString()],
                }
            }, "asc", BI.from(1000).toHexString(), ckbAfterCursor)

            console.log("lightTxs.objects.length:", lightTxs.objects.length)
            console.log("ckbTxs.objects.length:", ckbTxs.objects.length)
            expect(lightTxs.objects.length == ckbTxs.objects.length, "light txs length not equal ckb txs length")
            for (let i = 0; i < lightTxs.objects.length; i++) {
                let lightTx = lightTxs.objects[i]
                let ckbTx = ckbTxs.objects[i]
                expect(lightTx.transaction.hash == ckbTx.txHash, "light tx hash not equal ckb tx hash")
                expect(lightTx.blockNumber == ckbTx.blockNumber, "light block number not equal ckb tx hash")
                expect(lightTx.cells == ckbTx.cells, "light block number not equal ckb tx hash")
                expect(lightTx.txIndex == ckbTx.txIndex, "light block number not equal ckb tx hash")
            }
            lightAfterCursor = lightTxs.lastCursor
            ckbAfterCursor = ckbTxs.lastCursor
            console.log("lightAfterCursor:", lightAfterCursor)

        }
    })

});
