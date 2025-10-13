import Cryptr from 'cryptr'
import { envString } from './env'

const cryptr = new Cryptr(envString('PWD_SECRET') as string, { encoding: 'base64' })

export const encrypt = (text: string) => cryptr.encrypt(text)

const decryptedValueCache: { [key: string]: string } = {}

export const decrypt = (text: string) => {
    if (decryptedValueCache[text]) return decryptedValueCache[text]
    const decrypted = cryptr.decrypt(text)
    decryptedValueCache[text] = decrypted
    return decrypted
}