import { getSelectedModelParams } from "@/lib/ai/model-server"
import { Dao } from "@/lib/db/mysql"
import { CargaDeConteudoEnum, obterDadosDoProcesso2 } from "@/lib/proc/process"
import { getCurrentUser } from "@/lib/user"

export async function GET(req: Request) {
    const pUser = getCurrentUser()
    const user = await pUser
    if (!user) return Response.json({ errormsg: 'Usuário não autenticado' }, { status: 401 })

    const url = new URL(req.url)
    const dadosDoProcesso = await obterDadosDoProcesso2({ numeroDoProcesso: '01015894820201000000', pUser, conteudoDasPecasSelecionadas: CargaDeConteudoEnum.NAO })

    const userId = await Dao.assertIAUserId(user.preferredUsername || user.name)

    const params = await getSelectedModelParams()

    const r: any = {
        pass: undefined,
        tests: [
            {
                name: 'user',
                descr: 'verifica se o usuário está autenticado corretamente',
                pass: user ? true : 'USUÁRIO NÃO AUTORIZADO'
            },
            {
                name: 'process',
                descr: 'verifica se um processo pode ser obtido no DataLake e se ele contém peças além das peças públicas',
                pass: dadosDoProcesso.errorMsg ? dadosDoProcesso.errorMsg : !!dadosDoProcesso.arrayDeDadosDoProcesso[0].pecas.find(p => p.descr === 'OUTRAS PEÇAS') ? true : 'PEÇAS NÃO LOCALIZADAS'
            },
            {
                name: 'database',
                descr: 'verifica se o banco de dados está acessível',
                pass: userId
            },
            {
                name: 'model',
                descr: 'verifica se o modelo está acessível',
                pass: params?.model
            },
        ]
    }

    r.pass = Object.values(r.tests).every(v => v === true)

    return Response.json(r)
}