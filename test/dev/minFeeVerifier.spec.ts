import {generateAccountFromPrivateKey} from "../../service/transfer";
import {ACCOUNT_PRIVATE, ACCOUNT_PRIVATE2, lightClientRPC, rpcDevCLient} from "../../config/config";
import {
    cleanAllEnv,
    cleanAndRestartCkbLightClientEnv,
    miner_block, miner_block_until_number,
    startEnv,
    transferDevService
} from "../../service/CkbDevService";
import {Sleep} from "../../service/util";
import {checkScriptsInLightClient, waitScriptsUpdate} from "../../service/lightService";
import {BI} from "@ckb-lumos/bi";
import {expect} from "chai";

describe('minFeeVerifier', function () {


    this.timeout(10000000)
    let miner = generateAccountFromPrivateKey(ACCOUNT_PRIVATE)
    let acc2 = generateAccountFromPrivateKey(ACCOUNT_PRIVATE2);
    async function initLightClient() {
        if (!(await checkScriptsInLightClient([miner.lockScript, acc2.lockScript]))) {
            await lightClientRPC.setScripts([
                {
                    script: miner.lockScript,
                    scriptType: "lock",
                    blockNumber: "0x0"
                },
                {
                    script: acc2.lockScript,
                    scriptType: "lock",
                    blockNumber: "0x0"
                }
            ])
        }

        let tip_num = await rpcDevCLient.getTipBlockNumber()
        await waitScriptsUpdate(BI.from(tip_num))
    }

    before(async () => {
        await cleanAllEnv();
        await startEnv();
        await Sleep(3000);
        await initLightClient();
    })

    it("fee too low",async ()=>{
        await miner_block()
        let tip_num = await rpcDevCLient.getTipBlockNumber()
        await waitScriptsUpdate(BI.from(tip_num))
        // transfer fee too low
        try {
            await transferDevService.transfer({
                from: miner.address,
                to: acc2.address,
                amount: BI.from(100).toHexString(),
                privKey: ACCOUNT_PRIVATE,
                fee: 1,
                lightMode:true,
                lightNotInstallCellMode:true
            })
        } catch (e) {
            console.log("expect error:", e)
            expect(e.message).to.include("Transaction rejected by low fee rate");
            let tx = await transferDevService.transfer({
                from: miner.address,
                to: acc2.address,
                amount: BI.from(100).toHexString(),
                privKey: ACCOUNT_PRIVATE,
                fee: 4640,
                lightMode:true,
                lightNotInstallCellMode:true
            });
            await Sleep(1000)
            let txMsg = await rpcDevCLient.getTransaction(tx);
            console.log(txMsg.txStatus.status)

            await miner_block()
            await Sleep(1000)
            await miner_block()
            txMsg = await rpcDevCLient.getTransaction(tx);
            console.log(txMsg.txStatus.status)
            expect(txMsg.txStatus.status).to.be.equal("committed")
            return
        }
        expect.fail("should throw error when fee too low")
    })

});
