import {request} from "./index";
import {Sleep} from "./util";
import {Cell} from "@ckb-lumos/base/lib/api";
import {BI, HexadecimalRange} from "@ckb-lumos/lumos";
import {CKB_LIGHT_RPC_URL, FEE, RPC_DEBUG} from "../config/config";
import {LightClientRPC} from "@ckb-lumos/light-client";
import {FetchFlag} from "@ckb-lumos/light-client/lib/type";
import {Script, utils} from "@ckb-lumos/base";
import {RPC} from "@ckb-lumos/rpc/lib/types/rpc";
import ScriptType = RPC.ScriptType;
import {CKBRPC} from "@ckb-lumos/rpc";


export async function fetchTransactionUntilFetched(hash: string, ckbLightClientUrl, waitSize: number) {
    const ckbLightClient = new LightClientRPC(ckbLightClientUrl)
    let res;
    for (let i = 0; i < waitSize; i++) {
        res = await ckbLightClient.fetchTransaction(hash)
        if (res.status === FetchFlag.Fetched) {
            return res
        }
        console.log('fetch size:', i, ' fetch status:', res.status)
        await Sleep(1000)
    }
    throw new Error("time out ")
}

export async function getTransactionWaitCommit(hash: string, ckbLightClient, waitSize: number) {
    let res;
    for (let i = 0; i < waitSize; i++) {
        res = await request(1, ckbLightClient, "get_transaction", [hash]);
        if (res.tx_status.status === 'committed') {
            return res
        }
        await Sleep(1000)
    }
    return res
}

// export async function setScriptContainsAllLiveOutPut(script: ScriptObject, ckbLightClientUrl: string, ckbIndexUrl: string) {
//     const ckbLightClient = new LightClientRPC(ckbLightClientUrl)
//
//     let cellObjs = await ckbLightClient.getCells()
//     // getCells(script, "lock", ckbIndexUrl)
//     let cells = cellObjs.objects
//     // if (cells.length <1){
//     //     return
//     // }
//     await setScripts([{
//         script: script,
//         script_type: "lock",
//         // block_number:BI.from(cells[0].block_number).sub(1).toHexString()
//         block_number: BI.from(6630108).toHexString()
//     }])
//     let header = await getTipHeader(ckbLightClient)
//     await waitScriptsUpdate(BI.from(header.number), ckbLightClient)
// }

export async function getInputCellsByScript(script: Script, ckbLightClientUrl: string, script_type = "lock"): Promise<Cell[]> {
    const ckbLightClient = new LightClientRPC(ckbLightClientUrl)
    let rt = await ckbLightClient.getCells(
        {
            script: script,
            scriptType: "lock",
            withData: true
        },
        "asc",
        "0x16")
    // @ts-ignore
    //todo check
    return rt.objects
}


export function getTransferExtraLockCell(inputCell: Cell[], script: Script, extra: number = 1): Cell[] {
    const minCellBalance = 100 * 100000000
    let cells = []

    // get inputCell cap
    const totalCap = inputCell.reduce((total, cell) => {
        return total.add(BI.from(cell.cellOutput.capacity))
    }, BI.from(0))

    // cap - fee
    const transferCap = totalCap.sub(FEE)
    // gen output cells

    const maxOutPutCellSize = transferCap.div(minCellBalance).sub(1).toNumber()

    if (maxOutPutCellSize <= 0) {
        throw new Error("cap not enough:" + transferCap.toNumber())
    }
    if (extra > maxOutPutCellSize) {
        extra = maxOutPutCellSize
    }
    for (let i = 0; i < extra - 1; i++) {
        cells.push({
            cellOutput: {
                capacity: BI.from(100).mul(100000000).toHexString(),
                lock: script
            },
            data: '0x'
        })
    }

    return cells

}

export async function getCkbTransactionList(scriptObject: Script, script_type: ScriptType, lastCursor: string, ckbLightClientUrl: string, block_range?: HexadecimalRange): Promise<string[]> {
    const ckbLightClient = new CKBRPC(ckbLightClientUrl)

    let txList: string[] = []
    while (true) {
        let result = await ckbLightClient.getTransactions({
                script: scriptObject,
                scriptType: script_type,
                groupByTransaction: true,
                filter: {
                    blockRange: block_range
                }

            },
            "asc",
            BI.from(1000).toHexString(), lastCursor
        )
        if (result.objects.length == 0) {
            return txList
        }
        for (let i = 0; i < result.objects.length; i++) {
            let tx = result.objects[i]
            if (tx.txHash != null) {
                txList.push(tx.txHash)
                continue
            }
            txList.push(tx.txHash)
        }
        lastCursor = result.lastCursor
        if (RPC_DEBUG) {
            console.log('current totalSize:', txList.length, 'cursor:', lastCursor)
        }
    }
}


export async function getLightTransactionList(scriptObject: Script, script_type: ScriptType, lastCursor: string, ckbLightClientUrl: string, block_range?: HexadecimalRange): Promise<string[]> {
    const ckbLightClient = new LightClientRPC(ckbLightClientUrl)

    let txList: string[] = []
    while (true) {
        let result = await ckbLightClient.getTransactions({
                script: scriptObject,
                scriptType: script_type,
                groupByTransaction: true,
                filter: {
                    blockRange: block_range
                }

            },
            "asc",
            BI.from(1000).toHexString(),lastCursor
        )
        if (result.objects.length == 0) {
            return txList
        }
        for (let i = 0; i < result.objects.length; i++) {
            let tx = result.objects[i]
            if (tx.transaction.hash != null) {
                txList.push(tx.transaction.hash)
                continue
            }
            txList.push(tx.transaction.hash)
        }
        lastCursor = result.lastCursor
        if (RPC_DEBUG) {
            console.log('current totalSize:', txList.length, 'cursor:', lastCursor)
        }
    }
}

export async function getTransactionsLength(scriptObject: Script, script_type: ScriptType, lastCursor: string, ckbLightClientUrl: string, block_range?: HexadecimalRange) {
    let totalSize = 0
    const ckbLightClient = new LightClientRPC(ckbLightClientUrl)

    while (true) {
        let result = await ckbLightClient.getTransactions({
                script: scriptObject,
                scriptType: script_type,
                groupByTransaction: true,
                filter: {
                    blockRange: block_range
                }

            },
            "asc",
            BI.from(1000).toHexString()
        )
        if (result.objects.length == 0) {
            break
        }
        totalSize += result.objects.length
        lastCursor = result.lastCursor
        console.log('current totalSize:', totalSize, 'cursor:', lastCursor)
    }
    return totalSize
}

// export async function fetchTransactionW
export async function getCellsByRange(scriptObject: Script, script_type: ScriptType, lastCursor: string, ckbLightClientUrl: string, block_range: HexadecimalRange): Promise<Cell[]> {
    let txList = []
    const ckbLightClient = new LightClientRPC(ckbLightClientUrl)
    while (true) {
        let result = await ckbLightClient.getCells({
            script: scriptObject,
            scriptType: script_type,
            filter: {
                blockRange: block_range
            }
        }, "asc", "0x1ff", lastCursor)
        if (result.objects.length == 0) {
            break
        }
        for (let i = 0; i < result.objects.length; i++) {
            txList.push(result.objects[i])
        }
        lastCursor = result.lastCursor
        console.log('current totalSize:', txList.length, 'cursor:', lastCursor)
    }
    return txList
}

export async function getHeader(hash: string, ckbLightClient: string = CKB_LIGHT_RPC_URL) {
    const res = await request(1, ckbLightClient, "get_header", [hash]);
    return utils.deepCamel(res);
}
