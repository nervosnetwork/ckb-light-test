import {exec} from "child_process";
import {request} from "./index";
import {checkLightClientWasm} from "../config/config";


class LightClient {

    readonly dirPath: string;
    readonly url: string;

    constructor(path: string) {
        this.dirPath = path
        this.url = "http://localhost:9000"
    }

    async start(): Promise<boolean> {
        if (checkLightClientWasm()){
            await request(1,this.url,"start",[])
            await sleep(5*1000)
            return true
        }
        await sh("cd " + this.dirPath + "/target/release && RUST_LOG=info,ckb_light_client=trace ./ckb-light-client run --config-file ./config.toml > node.log 2>&1 &")
        await sleep(5*1000)
        return true
    }

    async stop(): Promise<boolean> {
        if (checkLightClientWasm()){
            await request(1,this.url,"stop",[])
            return true
        }
        await sh("pkill ckb-light")
        return true
    }

    async clean(): Promise<boolean> {
        if (checkLightClientWasm()){
            await request(1,this.url,"new_client",[])
            await request(1,this.url,"stop",[])
            return true
        }
        try {
            await this.stop()

        } catch (e) {
            console.log(e)
        }
        await sleep(1000)

        await sh("rm -rf " + this.dirPath + "/target/release/data")
        return true
    }

    async status(): Promise<any> {
        try {
            await sh("curl " + this.url + "/ -X POST -H \"Content-Type: application/json\" -d '{\"jsonrpc\": \"2.0\", \"method\": \"get_tip_header\", \"params\": [], \"id\": 1}'")
            return true
        } catch (e) {
            console.log(e)
            return false
        }
    }
}

export {
    LightClient
}


export async function shWithTimeOutNotErr(cmd:string,timeout:number){
    console.log('sh:', cmd)
    return new Promise(function (resolve, reject) {
        let c = exec(cmd, { timeout: timeout},(err, stdout, stderr) => {
            if (err) {
                // console.log(err)
                if(!c.killed){
                    c.kill()
                }
                resolve(err);
            } else {
                console.log('response:', stdout)
                resolve({stdout, stderr});
            }
        });
    });
}
export async function shWithTimeout(cmd:string,timeout:number){
    console.log('sh:', cmd)
    return new Promise(function (resolve, reject) {
        let c = exec(cmd, { timeout: timeout},(err, stdout, stderr) => {
            if (err) {
                console.log(err)
                console.log(c.pid)
                console.log("killed:",c.killed)
                // c.kill()
                console.log("killed:",c.killed)
                reject(err);
            } else {
                console.log('response:', stdout)
                resolve({stdout, stderr});
            }
        });
    });
}
export async function sh(cmd: string) {
   return await shWithTimeout(cmd,10000)

}


async function sleep(timeOut: number) {
    await new Promise(r => setTimeout(r, timeOut));
}

