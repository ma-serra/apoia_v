'use server'

import { Suspense } from 'react'
import { unstable_noStore as noStore } from 'next/cache'
import { Dao } from '@/lib/db/mysql'
import { Container, Spinner } from 'react-bootstrap'
import PromptInfoContents from './prompt-info-contents'
import { assertCurrentUser, isUserModerator } from '@/lib/user'
import { getInternalPrompt } from '@/lib/ai/prompt'
import { slugify } from '@/lib/utils/utils'
import { P, ProdutosValidos, TipoDeSinteseMap } from '@/lib/proc/combinacoes'

export default async function Home(props: { params: Promise<{ id: number }> }) {
    const params = await props.params;
    noStore()
    const user = await assertCurrentUser()
    const isModerator = await isUserModerator(user)
    let prompt = await Dao.retrieveLatestPromptByBaseId(params.id)

    if (prompt?.kind?.startsWith('^')) {
        const tipoDeSintese = TipoDeSinteseMap[prompt.kind.substring(1)]
        const p = tipoDeSintese?.produtos?.find(pr => pr != P.RESUMOS && pr != P.CHAT)
        const k = ProdutosValidos[p as P].prompt
        const def = getInternalPrompt(k)
        if (def) {
            // Convert PromptDefinitionType to IAPrompt content structure
            prompt = {
                id: 0,
                base_id: 0,
                created_by: user.id,
                model_id: null,
                testset_id: null,
                is_latest: 1,
                created_at: null,
                kind: def.kind,
                name: tipoDeSintese?.nome || def.kind,
                slug: slugify(def.kind),
                content: {
                    system_prompt: def.systemPrompt ?? null,
                    prompt: def.prompt ?? null,
                    json_schema: def.jsonSchema ?? null,
                    format: def.format ?? null,
                    template: def.template ?? null,
                }
            }
        }
    }

    console.log('Rendering Prompt Info for prompt ID:', prompt);



    return (
        <Container className="mt-5" fluid={false}>
            <h1 className="text-center">Informações de Prompt</h1>
            <Suspense fallback={
                <div className="text-center"><Spinner variant='secondary' /></div>
            }>
                <PromptInfoContents prompt={prompt} isModerator={isModerator} />
            </Suspense>
        </Container>
    )
}