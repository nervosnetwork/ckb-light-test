import {expect} from "chai";
import {ACCOUNT_PRIVATE, indexerMockLightRpc, lightClientRPC, rpcCLient} from "../config/config";
import {BI} from "@ckb-lumos/bi";
import {generateAccountFromPrivateKey} from "../service/transfer";
import {getHeader} from "../service/txService";
import {waitScriptsUpdate} from "../service/lightService";


describe('get_header', function () {

    this.timeout(600_000)
    it("dd",async ()=>{
        let acc = generateAccountFromPrivateKey(ACCOUNT_PRIVATE)
        console.log(acc)
    })
    it("query the hash that does not exist on the ckb chain,should return null", async () => {
        let response = await getHeader("0x1d7c6f92fa3335bf01c3f43f8970cb586d2dee81b90d363169dbe1bba98d6c11")
        console.log('response:', response)
        expect(response).to.be.equal(null)
    })
    it('query the collected hash,should return block msg', async () => {

        let script = generateAccountFromPrivateKey(ACCOUNT_PRIVATE).lockScript
        let cells = await indexerMockLightRpc.getCells({
            script:script,scriptType:"lock"
        }, "asc","0x1ff")

        // set scripts :( account,cells[0].height -1 ) ,want to collected cells that not used ;
        await lightClientRPC.setScripts([{script: script,scriptType:"lock", blockNumber: BI.from(cells.objects[0].blockNumber).sub(1).toHexString()}])

        // wait update height > cells[0].block_number
        await waitScriptsUpdate(BI.from(cells.objects[0].blockNumber))

        // get collect  cells hash
        let response = await lightClientRPC.getCells({
            script:script,
            scriptType:"lock"
        }, "asc", "0x1ff")

        let block = await rpcCLient.getBlockByNumber(response.objects[0].blockNumber.toString())
        if (block == undefined) {
            return
        }
        // get header from ckb light client
        let header = await getHeader(block.header.hash)
        expect(JSON.stringify(header).toString().length).to.be.equal(JSON.stringify(block.header).toString().length)

    })

    it("query hashes that have not been collected,should return null", async () => {
        let response = await lightClientRPC.getTipHeader()
        let header = await getHeader(response.hash)
        expect(header).to.be.equal(null)
    })

    it('query data that does not conform to the hash specification,should return error', async () => {
        try {
            await getHeader("0xb")
        } catch (e) {
            console.log(e)
            return
        }
        expect("").to.be.equal("failed")
    })
});
