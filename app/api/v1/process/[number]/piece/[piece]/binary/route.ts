import fetcher from "@/lib/utils/fetcher"
import { NextResponse } from "next/server"
import { getCurrentUser, assertApiUser } from "@/lib/user"
import { decrypt } from "@/lib/utils/crypt"
import { getInterop } from "@/lib/interop/interop"
import * as Sentry from '@sentry/nextjs'
import { UnauthorizedError, withErrorHandler } from '@/lib/utils/api-error'

export const maxDuration = 60
// export const runtime = 'edge'

/**
 * @swagger
 * 
 * /api/v1/process/{number}/piece/{piece}/binary:
 *   get:
 *     description: Obtem o conteúdo binário de uma peça processual
 *     tags:
 *       - process
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: number
 *         required: true
 *         description: Número do processo (apenas números)
 *       - in: path
 *         name: piece
 *         required: true
 *         description: Identificador da peça processual (apenas números)
 *     responses:
 *       200:
 *         description: Análise do processo no formato solicitado
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   description: OK se o conteúdo foi obtido com sucesso
 *                 content:
 *                   type: string
 *                   description: Conteúdo da peça processual
 */
async function GET_HANDLER(
  _req: Request,
  props: { params: Promise<{ number: string, piece: string }> }
) {
  const params = await props.params;
  const pUser = assertApiUser()
  const user = await pUser

  const username = user?.email
  const password = user?.encryptedPassword ? decrypt(user?.encryptedPassword) : undefined
  const system = user?.system
  const interop = getInterop(system, username, password)
  await interop.init()

  const { buffer, contentType } = await interop.obterPeca(params.number, params.piece, true)

  return new Response(buffer, {
    headers: {
      'Content-Type': contentType,
    },
    status: 200,
  })
}

export const GET = withErrorHandler(GET_HANDLER as any)