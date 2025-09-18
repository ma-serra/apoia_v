import { assertCurrentUser, getCurrentUser } from "../user"
import { slugify } from "../utils/utils"
import * as mysqlTypes from "./mysql-types"
import knex from './knex'
import { PromptDataType } from "../ai/prompt-types"
import { Instance, Matter, Scope } from "../proc/process-types"
import { envNumber, envString } from "../utils/env"
import { dailyLimits } from "../utils/limits"
import { IS_APPLE } from "@mdxeditor/editor"
import type { IABatch, IABatchJob, IABatchSummary } from './mysql-types'

function getId(returning: number | { id: number }): number {
    return typeof returning === 'number' ? returning : returning.id
}

async function getCurrentUserId() {
    const user = await assertCurrentUser()
    return await Dao.assertIAUserId(user.preferredUsername || user.name)
}

export class Dao {
    // Rewrite all mappings for a batch: delete existing and insert the new set
    static async rewriteBatchFixIndexMap(batch_id: number, pairs: { descr_from: string, descr_to: string }[]): Promise<number> {
        if (!knex) return 0
        return await knex.transaction(async (trx) => {
            await trx('ia_batch_index_map').where({ batch_id }).delete()
            if (!pairs.length) return 0
            const rows = pairs.map(p => ({ batch_id, descr_from: p.descr_from, descr_to: p.descr_to }))
            const inserted = await trx('ia_batch_index_map').insert(rows).returning('id')
            return Array.isArray(inserted) ? inserted.length : (inserted ? 1 : 0)
        })
    }

    static async listBatchFixIndexMap(batch_id: number): Promise<{ descr_from: string, descr_to: string }[]> {
        if (!knex) return []
        const rows = await knex('ia_batch_index_map').select('descr_from', 'descr_to').where({ batch_id }).orderBy('descr_from').orderBy('descr_to')
        return rows as any
    }
    static async addInternalPrompt(kind: string): Promise<mysqlTypes.IAPrompt> {
        if (!knex) return {} as mysqlTypes.IAPrompt
        const [result] = await knex('ia_prompt').insert<mysqlTypes.IAPrompt>({
            kind,
            name: kind,
            slug: slugify(kind),
            content: JSON.stringify({ prompt: null }),
            is_latest: 1, share: 'PADRAO'
        }).returning('id')
        const id = getId(result)
        await knex('ia_prompt').update({ base_id: id }).where({ id })
        const record = await knex('ia_prompt').select<mysqlTypes.IAPrompt>('*').where({ id }).first()
        return record
    }

    static async removeInternalPrompt(kind: string): Promise<boolean> {
        if (!knex) return false
        const result = await knex('ia_prompt').update({ is_latest: 0 }).where({ kind })
        return result > 0
    }

    // Retrieve all latest seeded prompts (kind starting with '^%') for overlaying map info
    static async retrieveLatestSeededPrompts(): Promise<mysqlTypes.IAPrompt[]> {
        if (!knex) return [] as any
        const result = await knex('ia_prompt')
            .select<mysqlTypes.IAPrompt[]>('*')
            .where('is_latest', 1)
            .andWhere('kind', 'like', '^%')
        for (const record of result) this.hydratatePromptContent(record.content)
        return result
    }
    static async insertIATestset(data: mysqlTypes.IATestsetToInsert): Promise<mysqlTypes.IATestset | undefined> {
        const { base_testset_id, kind, name, model_id, content } = data
        const slug = slugify(name)
        const created_by = await getCurrentUserId()
        const [insertedid] = await knex('ia_testset').insert({
            base_id: base_testset_id, kind, name, slug, model_id, content, created_by
        }).returning('id')
        const inserted = await knex.select().from<mysqlTypes.IATestset>('ia_testset').where({ id: getId(insertedid) }).first()
        return inserted
    }

    static async setOfficialTestset(id: number): Promise<boolean> {
        const trx = await knex.transaction()
        try {
            const testset = await Dao.retrieveTestsetById(id)
            if (!testset) throw new Error('Testset not found')
            const { kind, slug } = testset
            await trx('ia_testset').update({
                is_official: 0
            }).where({
                kind,
                slug,
                id
            })
            await trx('ia_testset').update<mysqlTypes.IAPrompt>({
                is_official: 1
            }).where({ id })
            await trx.commit()
            return true
        } catch (error) {
            await trx.rollback()
            console.error(`Dao error ${error?.message}`)
            return false
        }
    }

    static async removeOfficialTestset(id: number): Promise<boolean> {
        await knex('ia_testset').update({ is_official: 0 }).where({ id })
        return true
    }

    static async retrieveTestsetById(id: number): Promise<mysqlTypes.IATestset | undefined> {
        if (!knex) return
        const result = await knex.select().from<mysqlTypes.IATestset>('ia_testset').where({ id }).first()
        return result
    }

    static dehydratatePromptContent = (content: any): void => {
        if (content?.scope && content.scope.length === Object.keys(Scope).length) content.scope = null
        if (content?.instance && content.instance.length === Object.keys(Instance).length) content.instance = null
        if (content?.matter && content.matter.length === Object.keys(Matter).length) content.matter = null
    }

    static hydratatePromptContent = (content: any): void => {
        if (content?.scope === null) content.scope = Object.keys(Scope)
        if (content?.instance === null) content.instance = Object.keys(Instance)
        if (content?.matter === null) content.matter = Object.keys(Matter)
    }


    static async insertIAPrompt(conn: any, data: mysqlTypes.IAPromptToInsert): Promise<mysqlTypes.IAPrompt | undefined> {
        const { base_id, kind, name, model_id, testset_id, share, content } = data
        const slug = slugify(name)
        const created_by = await getCurrentUserId()
        if (data.base_id) {
            await knex('ia_prompt').update({ is_latest: 0 }).where({ base_id: data.base_id })
        }
        this.dehydratatePromptContent(data.content)
        const [result] = await knex('ia_prompt').insert<mysqlTypes.IAPrompt>({
            base_id: base_id,
            kind, name, slug, model_id, testset_id, content: JSON.stringify(content), created_by, is_latest: 1, share
        }).returning('id')
        const id = getId(result)
        if (!data.base_id) {
            await knex('ia_prompt').update({ base_id: id }).where({ id })
        }
        const record = await knex('ia_prompt').select<mysqlTypes.IAPrompt>('*').where({ id }).first()
        return record
    }

    static async setOfficialPrompt(id: number): Promise<boolean> {
        const trx = await knex.transaction()

        const prompt = await Dao.retrievePromptById(id)
        if (!prompt) throw new Error('Prompt not found')
        try {
            await trx('ia_prompt').update<mysqlTypes.IAPrompt>({
                is_official: 0,
            }).where({ kind: prompt.kind, slug: prompt.slug, id })
            await trx('ia_prompt').update<mysqlTypes.IAPrompt>({
                is_official: 1
            }).where({ id })
            await trx.commit()
            return true
        } catch (error) {
            trx.rollback()
            console.error(error?.message)
            return false
        }
    }

    static async removeOfficialPrompt(id: number): Promise<boolean> {
        const updates = await knex('ia_prompt').update({
            is_official: 0
        }).where({ id }).returning('*')
        return updates.length > 0
    }

    static async removeLatestPrompt(base_id: number): Promise<boolean> {
        const created_by = await getCurrentUserId()
        const updates = await knex('ia_prompt').update({
            is_latest: 0
        }).where({ base_id, created_by }).returning('*')
        return updates.length > 0
    }


    static async retrievePromptById(id: number): Promise<mysqlTypes.IAPrompt | undefined> {
        const result = await knex.select().from<mysqlTypes.IAPrompt>('ia_prompt').where({ id }).first()
        this.hydratatePromptContent(result.content)
        return result
    }

    static async retrieveLatestPromptByBaseId(base_id: number): Promise<mysqlTypes.IAPrompt | undefined> {
        const result = await knex.select().from<mysqlTypes.IAPrompt>('ia_prompt').where({ base_id, is_latest: 1 }).first()
        this.hydratatePromptContent(result.content)
        return result
    }

    static async retrieveCountersByPromptKinds(): Promise<{ kind: string, prompts: number, testsets: number }[]> {
        if (!knex) return
        const sql = knex('ia_prompt as p')
            .select(
                'k.kind',  // Select 'kind' from the union of both tables
                knex.raw('COUNT(DISTINCT p.slug) as prompts'),  // Count distinct slugs in ia_prompt
                knex.raw('COUNT(DISTINCT t.slug) as testsets')  // Count distinct slugs in ia_testset
            )
            .leftJoin(
                knex
                    .select('kind')
                    .from('ia_prompt')
                    .union(function () {
                        this.select('kind').from('ia_testset');
                    })
                    .as('k'), 'p.kind', '=', 'k.kind'
            )
            .leftJoin('ia_testset as t', 't.kind', '=', 'p.kind')
            .groupBy('k.kind');  // Group by 'kind' from the union
        // console.log('***counters', sql.toString());
        const result = await sql

        if (!result || result.length === 0) return []
        const records = result.map((record: any) => ({ ...record }))
        return records
    }

    static async retrievePromptsByKind(conn: any, kind: string): Promise<{ slug: string, name: string, versions: number, created_at: Date, modified_at: Date, official_at: Date, created_id: number, modified_id: number, official_id: number }[]> {
        if (!knex) return
        // Consulta interna que utiliza funções de janela
        const innerQuery = knex('ia_prompt')
            .select([
                'slug',
                knex.raw(`FIRST_VALUE(created_at) OVER (PARTITION BY slug ORDER BY created_at) AS created_at`),
                knex.raw(`FIRST_VALUE(id) OVER (PARTITION BY slug ORDER BY created_at) AS created_id`),
                knex.raw(`FIRST_VALUE(created_at) OVER (PARTITION BY slug ORDER BY created_at DESC) AS modified_at`),
                knex.raw(`FIRST_VALUE(id) OVER (PARTITION BY slug ORDER BY created_at DESC) AS modified_id`),
                knex.raw(`FIRST_VALUE(name) OVER (PARTITION BY slug ORDER BY created_at DESC) AS name`)
            ])
            .where('kind', kind);

        // Definição da CTE t1
        const t1Query = knex
            .select([
                'slug',
                knex.raw('MIN(created_at) AS created_at'),
                knex.raw('MIN(created_id) AS created_id'),
                knex.raw('MIN(modified_at) AS modified_at'),
                knex.raw('MIN(modified_id) AS modified_id'),
                knex.raw('MIN(name) AS name'),
                knex.raw('COUNT(*) AS versions')
            ])
            .from({ p: innerQuery } as any)
            .groupBy('slug')
            .orderBy('slug');

        // Definição da CTE t2 que depende de t1
        const t2Query = knex
            .select([
                't1.*',
                knex.raw('o.id AS official_id'),
                knex.raw('o.created_at AS official_at')
            ])
            .from('t1')
            .leftJoin({ o: 'ia_prompt' }, function () {
                this.on('t1.slug', '=', 'o.slug').andOn('o.is_official', '=', knex.raw('?', [true]));
            });

        // Consulta final que utiliza as CTEs t1 e t2
        const finalQuery = knex
            .with('t1', t1Query)
            .with('t2', t2Query)
            .select('t2.*')
            .from('t2');

        // Exibe a consulta SQL gerada
        // console.log('***prompts', finalQuery.toString());
        const result = await finalQuery
        if (!result || result.length === 0) return []
        const records = result.map((record: any) => ({ ...record }))
        for (const record of records) {
            this.hydratatePromptContent(record.content)
        }
        return records
    }

    static async retrieveTestsetsByKind(conn: any, kind: string): Promise<{ slug: string, name: string, versions: number, created: Date, modified: Date }[]> {
        if (!knex) return
        // Consulta interna que utiliza funções de janela
        const innerQuery = knex('ia_testset')
            .select([
                'slug',
                knex.raw(`FIRST_VALUE(created_at) OVER (PARTITION BY slug ORDER BY created_at) AS created_at`),
                knex.raw(`FIRST_VALUE(id) OVER (PARTITION BY slug ORDER BY created_at) AS created_id`),
                knex.raw(`FIRST_VALUE(created_at) OVER (PARTITION BY slug ORDER BY created_at DESC) AS modified_at`),
                knex.raw(`FIRST_VALUE(id) OVER (PARTITION BY slug ORDER BY created_at DESC) AS modified_id`),
                knex.raw(`FIRST_VALUE(name) OVER (PARTITION BY slug ORDER BY created_at DESC) AS name`)
            ])
            .where('kind', kind)

        // Definição da CTE t1
        const t1Query = knex
            .select([
                'slug',
                knex.raw('MIN(created_at) AS created_at'),
                knex.raw('MIN(created_id) AS created_id'),
                knex.raw('MIN(modified_at) AS modified_at'),
                knex.raw('MIN(modified_id) AS modified_id'),
                knex.raw('MIN(name) AS name'),
                knex.raw('COUNT(*) AS versions')
            ])
            .from({ p: innerQuery } as any)
            .groupBy('slug')
            .orderBy('slug')

        // Definição da CTE t2 que depende de t1
        const t2Query = knex
            .select([
                't1.*',
                knex.raw('o.id AS official_id'),
                knex.raw('o.created_at AS official_at')
            ])
            .from('t1')
            .leftJoin({ o: 'ia_testset' }, function () {
                this.on('t1.slug', '=', 'o.slug').andOn('o.is_official', '=', knex.raw('?', [true]))
            })

        // Consulta final que utiliza as CTEs t1 e t2
        const finalQuery = knex
            .with('t1', t1Query)
            .with('t2', t2Query)
            .select('t2.*')
            .from('t2');

        // Ou para ver a consulta SQL gerada:
        // console.log('***testsets', finalQuery.toString());
        const result = await finalQuery
        if (!result || result.length === 0) return []
        const records = result.map((record: any) => ({ ...record }))
        return records
    }

    static async retrievePromptsIdsAndNamesByKind(kind: string): Promise<mysqlTypes.SelectableItemWithLatestAndOfficial[]> {
        if (!knex) return
        const result = await knex('ia_prompt')
            .select('id', 'name', 'slug', 'created_at', 'is_official')
            .where('kind', kind)
            .orderBy('slug')
            .orderBy('created_at', 'desc')
        if (!result || result.length === 0) return []
        result.forEach((record: any, index: number) => {
            record.is_last = index === 0 || record.slug !== result[index - 1].slug
        })
        const records = result.map((record: any) => ({ ...record }))
        return records
    }

    static async retrieveOfficialPromptsIdsAndNamesByKind(kind: string): Promise<{ id: string, name: string }[]> {
        if (!knex) return
        const result = await knex('ia_prompt').select<Array<mysqlTypes.IAPrompt>>('id', 'name').where({
            kind, is_official: 1
        })
        if (!result || result.length === 0) return []
        const records = result.map((record: any) => ({ ...record }))
        return records
    }

    static async retrieveOfficialTestsetsIdsAndNamesByKind(kind: string): Promise<{ id: string, name: string }[]> {
        if (!knex) return
        const result = await knex('ia_testset').select<Array<mysqlTypes.IATestset>>('id', 'name').where({
            kind, is_official: 1
        })
        if (!result || result.length === 0) return []
        const records = result.map((record: any) => ({ ...record }))
        return records
    }

    static async setFavorite(prompt_id: number, user_id: number): Promise<boolean> {
        await this.resetFavorite(prompt_id, user_id)
        await knex('ia_favorite').insert({ prompt_id, user_id })
        return true
    }

    static async resetFavorite(prompt_id: number, user_id: number): Promise<boolean> {
        await knex('ia_favorite')
            .delete()
            .where({ prompt_id, user_id });
        return true;
    }

    static async setPrivate(prompt_id: number): Promise<boolean> {
        await knex('ia_prompt').update({ share: 'PRIVADO' }).where({ id: prompt_id })
        return true
    }

    static async setUnlisted(prompt_id: number): Promise<boolean> {
        await knex('ia_prompt').update({ share: 'NAO_LISTADO' }).where({ id: prompt_id })
        return true
    }

    static async setPublic(prompt_id: number): Promise<boolean> {
        await knex('ia_prompt').update({ share: 'PUBLICO' }).where({ id: prompt_id })
        return true
    }

    static async setStandard(prompt_id: number): Promise<boolean> {
        await knex('ia_prompt').update({ share: 'PADRAO' }).where({ id: prompt_id })
        return true
    }

    static async retrieveOfficialPrompts(): Promise<mysqlTypes.IAPrompt[]> {
        if (!knex) return
        const result = await knex('ia_prompt').select<Array<mysqlTypes.IAPrompt>>('*').where({ is_official: 1 })
        if (!result || result.length === 0) return []
        for (const record of result) {
            this.hydratatePromptContent(record.content)
        }
        return result
    }

    static async retrieveLatestPrompts(user_id: number, moderator?: boolean): Promise<mysqlTypes.IAPromptList[]> {
        if (!knex) return
        const result = await knex('ia_prompt')
            .leftJoin('ia_favorite as f', function () {
                this.on('ia_prompt.base_id', '=', 'f.prompt_id')
                    .andOn('f.user_id', '=', knex.raw('?', [user_id]));
            })
            .select(
                'ia_prompt.*',
                knex.raw('(ia_prompt.created_by = ?) as is_mine', [user_id]),
                knex.raw('CASE WHEN COUNT(f.prompt_id) > 0 THEN 1 ELSE 0 END as is_favorite'),
                knex.raw('(SELECT COUNT(*) FROM ia_favorite as f WHERE f.prompt_id = ia_prompt.base_id) as favorite_count')
            )
            .where('ia_prompt.is_latest', 1)
            .andWhere(function () {
                this.where('ia_prompt.created_by', user_id)
                    .orWhere('ia_prompt.share', 'PADRAO')
                    .orWhere('ia_prompt.share', 'PUBLICO')
                    .orWhere(function () {
                        if (moderator) {
                            this.orWhere('ia_prompt.share', 'EM_ANALISE')
                        }
                    })
                    .orWhere(function () {
                        this.where('ia_prompt.share', 'NAO_LISTADO')
                            .whereNotNull('f.prompt_id')
                    })
            })
            .groupBy('ia_prompt.id')

        // const result = await knex('ia_prompt')
        //     .select(
        //         'ia_prompt.*',
        //         knex.raw('(created_by = ?) as is_mine', [user_id]),
        //         knex.raw('(SELECT COUNT(*) FROM ia_favorite as f WHERE f.prompt_id = ia_prompt.base_id and f.user_id = ?) as is_favorite', [user_id]),
        //         knex.raw('(SELECT COUNT(*) FROM ia_favorite as f WHERE f.prompt_id = ia_prompt.base_id) as favorite_count')
        //     )
        //     .where('is_latest', 1)
        //     .andWhere(function () {
        //         this.where('created_by', user_id)
        //             .orWhere('share', 'PUBLICO')
        //             .orWhereRaw("(SELECT COUNT(*) FROM ia_favorite as f WHERE f.prompt_id = ia_prompt.base_id and f.user_id = ?) > 0", [user_id]);
        //     });
        if (!result || result.length === 0) return []
        for (const record of result) {
            this.hydratatePromptContent(record.content)
        }
        result.sort((a, b) => {
            if (a.is_favorite && !b.is_favorite) return -1
            if (!a.is_favorite && b.is_favorite) return 1
            if (a.favorite_count > b.favorite_count) return -1
            if (a.favorite_count < b.favorite_count) return 1
            return 0
        })
        return result
    }

    static async retrieveModels(): Promise<{ id: string, name: string }[]> {
        if (!knex) return
        const result = await knex('ia_model').select<Array<mysqlTypes.IAModel>>('id', 'name')
        if (!result || result.length === 0) return []
        const records = result.map((record: any) => ({ ...record }))
        return records
    }

    static async retrieveModelById(id: number): Promise<mysqlTypes.IAModel | undefined> {
        if (!knex) return
        const result = await knex('ia_model').select<Array<mysqlTypes.IAModel>>('*').where({ id }).first()
        return result
    }

    static async retrievePromptsByKindAndSlug(kind: string, slug: string): Promise<mysqlTypes.PromptByKind[]> {
        if (!knex) return
        const result = await knex('ia_prompt as p')
            .select<Array<mysqlTypes.PromptByKind>>(
                'p.id',
                'p.testset_id',
                'p.model_id',
                'p.kind',
                'p.name',
                'p.slug',
                'p.content',
                'p.created_by',
                'p.created_at',
                'p.is_official',
                't.slug as testset_slug',
                't.name as testset_name',
                'm.name as model_name',
                'u.username as user_username',
                's.score as score'
            )
            .leftJoin('ia_testset as t', 'p.testset_id', 't.id')
            .leftJoin('ia_model as m', 'p.model_id', 'm.id')
            .leftJoin('ia_user as u', 'p.created_by', 'u.id')
            .leftJoin('ia_test as s', function () {
                this.on('p.testset_id', '=', 's.testset_id')
                    .andOn('p.model_id', '=', 's.model_id')
                    .andOn('p.id', '=', 's.prompt_id');
            })
            .where('p.kind', kind)
            .andWhere('p.slug', slug)
            .orderBy('p.created_at', 'desc');

        if (!result || result.length === 0) return []
        const records = result.map((record: any) => ({ ...record }))
        return records
    }

    static async retrieveTestsetsByKindAndSlug(kind: string, slug: string): Promise<{ id: number, testset_id: number, model_id: number, kind: string, name: string, slug: string, content: any, created_by: number, created_at: Date, is_official: boolean, testset_slug: string, testset_name: string, model_name: string, user_username: string, score: number }[]> {
        if (!knex) return
        const result = await knex('ia_testset as p')
            .select(
                'p.id',
                'p.model_id',
                'p.kind',
                'p.name',
                'p.slug',
                'p.content',
                'p.created_by',
                'p.created_at',
                'p.is_official',
                'm.name as model_name',
                'u.username as user_username'
            )
            .leftJoin('ia_model as m', 'p.model_id', 'm.id')
            .leftJoin('ia_user as u', 'p.created_by', 'u.id')
            .where({ 'p.kind': kind, 'p.slug': slug })
            .andWhere('p.slug', slug)
            .orderBy('p.created_at', 'desc');
        if (!result || result.length === 0) return []
        const records = result.map((record: any) => ({ ...record }))
        return records
    }

    static async retrieveRanking(kind: string, testset_id?: number, prompt_id?: number, model_id?: number): Promise<mysqlTypes.IARankingType[]> {
        if (!knex) return
        const sql = knex('ia_test as s')
            .select<Array<mysqlTypes.IARankingType>>(
                's.testset_id',
                't.name as testset_name',
                't.slug as testset_slug',
                's.prompt_id',
                'p.name as prompt_name',
                'p.slug as prompt_slug',
                's.model_id',
                'm.name as model_name',
                's.score'
            )
            .innerJoin('ia_model as m', 's.model_id', 'm.id')
            .innerJoin('ia_prompt as p', 's.prompt_id', 'p.id')
            .innerJoin('ia_testset as t', function () {
                this.on('s.testset_id', '=', 't.id')
            })
            .where(function () {
                this.where('t.kind', '=', kind)
                if (testset_id)
                    this.where('s.testset_id', '=', testset_id)
                if (prompt_id)
                    this.where('s.prompt_id', '=', prompt_id)
                if (model_id)
                    this.where('s.model_id', '=', model_id)
            })
            .orderBy('s.score', 'desc')
        const result = await sql
        return result
    }

    static async insertIATest(test: mysqlTypes.IATest) {
        if (!knex) return
        await knex('ia_test').insert({
            testset_id: test.testset_id,
            prompt_id: test.prompt_id,
            model_id: test.model_id,
            score: test.score,
            content: JSON.stringify(test.content)
        })
    }

    static async retrieveTestByTestsetIdPromptIdAndModelId(testset_id: number, prompt_id: number, model_id: number): Promise<mysqlTypes.IATest | undefined> {
        if (!knex) return
        const result = await knex('ia_test').select<mysqlTypes.IATest>('*').where({
            testset_id, prompt_id, model_id
        }).first()
        return result
    }

    static async retrieveIAGeneration(data: mysqlTypes.IAGeneration): Promise<mysqlTypes.IAGenerated | undefined> {
        if (!knex) return
        const { model, prompt, sha256, attempt } = data
        const sql = knex('ia_generation').select<mysqlTypes.IAGenerated>('*').whereNull('evaluation_id').where({
            model,
            prompt,
            sha256,
        })
        if (attempt) {
            sql.where({ attempt })
        } else {
            sql.whereNull('attempt')
        }
        const result = await sql.first()
        return result
    }

    static async retrieveByBatchIdAndEnumId(batch_id: number, enum_id: number): Promise<mysqlTypes.AIBatchIdAndEnumId[]> {
        if (!knex) return
        const result = await knex('ia_batch as b')
            .select<mysqlTypes.AIBatchIdAndEnumId[]>(
                'd.code as dossier_code',
                'd.class_code as dossier_class_code',
                'd.filing_at as dossier_filing_at',
                'ei.id as enum_item_id',
                'ei.descr as enum_item_descr',
                'ei2.descr as enum_item_descr_main',
                'bd.id as batch_dossier_id',
                'bd.footer as batch_dossier_footer',
            )
            .innerJoin('ia_batch_dossier as bd', 'bd.batch_id', 'b.id')
            .innerJoin('ia_dossier as d', 'd.id', 'bd.dossier_id')
            .leftJoin('ia_batch_dossier_enum_item as bdei', 'bdei.batch_dossier_id', 'bd.id')
            .leftJoin('ia_enum_item as ei', 'ei.id', 'bdei.enum_item_id')
            .leftJoin('ia_enum as e', 'e.id', 'ei.enum_id')
            .leftJoin('ia_enum_item as ei2', 'ei2.id', 'ei.enum_item_id_main')
            .where({ 'b.id': batch_id, 'e.id': enum_id })
            .orderBy('ei.descr')
            .orderBy('d.code')
        return result

    }

    static async retrieveCountByBatchIdAndEnumId(batch_id: number, enum_id: number): Promise<mysqlTypes.AICountByBatchIdAndEnumId[]> {
        if (!knex) return
        const result = await knex('ia_batch as b')
            .select<mysqlTypes.AICountByBatchIdAndEnumId[]>('ei.descr as enum_item_descr', 'ei.hidden', knex.raw('count(distinct bd.id) as count'))
            .join('ia_batch_dossier as bd', 'bd.batch_id', '=', 'b.id')
            .join('ia_dossier as d', 'd.id', '=', 'bd.dossier_id')
            .join('ia_batch_dossier_enum_item as bdei', 'bdei.batch_dossier_id', '=', 'bd.id')
            .join('ia_enum_item as ei', 'ei.id', '=', 'bdei.enum_item_id')
            .join('ia_enum as e', 'e.id', '=', 'ei.enum_id').
            where({ 'b.id': batch_id, 'e.id': enum_id })
            .groupBy('ei.descr', 'ei.hidden')
        // .orderBy(knex.raw('count(distinct bd.id)'), 'desc');
        result.sort((a, b) => a.count - b.count)
        // console.log('result', result)
        return result
    }

    static async retrieveGenerationByBatchDossierId(batch_dossier_id: number): Promise<mysqlTypes.AIBatchDossierGeneration[]> {
        if (!knex) return
        const result = knex('ia_batch_dossier_item as bdi')
            .select<mysqlTypes.AIBatchDossierGeneration[]>(
                'bdi.descr',
                'g.generation',
                'g.prompt',
                'd.id as document_id',
                'd.code as document_code'
            )
            .innerJoin('ia_generation as g', 'g.id', 'bdi.generation_id')
            .leftJoin('ia_document as d', 'd.id', 'bdi.document_id')
            .where({
                'bdi.batch_dossier_id': batch_dossier_id
            })
            .orderBy('bdi.seq')
        return result
    }

    static async insertIAGeneration(data: mysqlTypes.IAGeneration): Promise<mysqlTypes.IAGenerated | undefined> {
        if (!knex) return
        const created_by = await getCurrentUserId()
        const prompt_payload = null
        const {
            // prompt_payload, 
            model, prompt, sha256, generation, attempt,
            dossier_id, document_id,
            cached_input_tokens, input_tokens, output_tokens, reasoning_tokens, approximate_cost } = data
        const [inserted] = await knex('ia_generation').insert({
            model, prompt, sha256, prompt_payload, generation, attempt,
            dossier_id, document_id,
            cached_input_tokens, input_tokens, output_tokens, reasoning_tokens, approximate_cost, created_by
        }).returning('id')
        const result = await knex('ia_generation').select<mysqlTypes.IAGenerated>('*').where('id', getId(inserted)).first()
        return result
    }

    static async evaluateIAGeneration(user_id: number, generation_id: number, evaluation_id: number, evaluation_descr: string | null): Promise<boolean | undefined> {
        if (!knex) return
        await knex('ia_generation').update({
            evaluation_user_id: user_id,
            evaluation_id,
            evaluation_descr
        }).where({ id: generation_id })
        return true
    }

    static async assertSystemId(code?: string): Promise<number> {
        if (!knex) return
        if (!code) {
            return 0
        }
        const item = await knex('ia_system').select<mysqlTypes.IASystem>('id').where('code', code).first()
        if (item) {
            return item.id
        } else {
            const [result] = await knex('ia_system').insert({ code }).returning('id')
            return getId(result)
        }
    }

    static async assertIABatchId(batchName: string): Promise<number> {
        if (!knex) return
        const created_by = await getCurrentUserId()
        // Prefer batch owned by current user
        let bach = await knex('ia_batch').select('id').where({ name: batchName, created_by }).first()
        if (!bach) {
            // Fallback to any batch with same name (legacy batches without created_by)
            bach = await knex('ia_batch').select('id').where({ name: batchName }).first()
        }
        if (bach) return bach.id
        const [created] = await knex('ia_batch').insert({ name: batchName, created_by }).returning('id')
        return getId(created)
    }

    static async assertIADossierId(code: string, system_id: number, class_code: number, filing_at: Date): Promise<number> {
        if (!knex) return
        const result = await knex('ia_dossier').select('id').where({
            code,
            system_id
        }).first()
        if (result) {
            if ((class_code && result.class_code !== class_code) || (filing_at && result.filing_at !== filing_at)) {
                await knex('ia_dossier').update({
                    class_code,
                    filing_at
                }).where({ id: result.id })
            }
            return result.id
        }
        const [dossierResult] = await knex('ia_dossier').insert({
            system_id,
            code,
            class_code,
            filing_at
        }).returning('id')
        return getId(dossierResult)
    }


    static async assertIADocumentId(dossier_id: number, code: string, assigned_category: string | null): Promise<number> {
        if (!knex) return
        let document = await knex('ia_document').select<mysqlTypes.IADocument[]>('id', 'assigned_category').where({ code }).first()
        if (document) {
            if (assigned_category && document.assigned_category !== assigned_category) {
                await knex('ia_document').update({ assigned_category }).where({ id: document.id })
            }
            return document.id
        }
        const [result] = await knex('ia_document').insert<mysqlTypes.IADocument>({
            code,
            dossier_id,
            assigned_category
        }).returning('id')
        return getId(result)
    }

    static async updateDocumentContent(document_id: number, content_source_id: number, content: string) {
        if (!knex) return
        await knex('ia_document').update({
            content_source_id,
            content: content?.replace(/\u0000/g, ''), // Remove null characters
        }).where({ id: document_id })
    }

    static async updateDocumentCategory(document_id: number, assigned_category: string | null, predicted_category: string | null) {
        if (!knex) return
        await knex('ia_document').update({
            assigned_category,
            predicted_category,
        }).where({ id: document_id })
    }

    static async verifyIfDossierHasDocumentsWithPredictedCategories(dossierCode: string): Promise<boolean> {
        if (!knex) return
        const result = await knex('ia_dossier as p')
            .join('ia_document as d', 'p.id', '=', 'd.dossier_id')
            .where({ 'p.code': dossierCode })
            .whereNotNull('d.predicted_category')
            .count('* as count').first()
        const total = result?.count as number ?? 0
        return total > 0
    }

    static async retrieveDocument(document_id: number): Promise<mysqlTypes.IADocument | undefined> {
        if (!knex) return
        const result = await knex('ia_document').select<mysqlTypes.IADocument>('*').where('id', document_id).first()
        return result
    }

    static async assertIABatchDossierId(batch_id: number, dossier_id: number, footer: string): Promise<number> {
        if (!knex) return
        // Check or insert document
        let batch_dossier_id: number | null = null
        const document = await knex('ia_batch_dossier').select('id').where({
            batch_id, dossier_id
        }).first()
        if (document) {
            return document.id as number
        }

        const [inserted] = await knex('ia_batch_dossier').insert({
            batch_id, dossier_id, footer
        }).returning('id')
        return getId(inserted)
    }

    static async deleteIABatchDossierId(batch_id: number, dossier_id: number): Promise<undefined> {
        if (!knex) return
        await knex('ia_batch_dossier').delete().where({ batch_id, dossier_id })
    }

    static async insertIABatchDossierItem(data: mysqlTypes.IABatchDossierItem): Promise<mysqlTypes.IABatchDossierItem | undefined> {
        if (!knex) return
        const { batch_dossier_id, document_id, generation_id, descr, seq } = data
        const [inserted] = await knex('ia_batch_dossier_item').insert({
            batch_dossier_id,
            document_id, generation_id, descr, seq
        }).returning('id')

        const result = await knex('ia_batch_dossier_item').select<mysqlTypes.IABatchDossierItem>('*').where('id', getId(inserted)).first()
        return result
    }

    static async assertIAEnumId(descr: string): Promise<number> {
        if (!knex) return
        const iaEnum = await knex('ia_enum').select('id').where({ descr, }).first()
        if (iaEnum) return iaEnum.id
        const [result] = await knex('ia_enum').insert({
            descr,
        }).returning("id")
        return getId(result)
    }

    static async assertIAEnumItemId(descr: string, enum_id: number): Promise<number> {
        if (!knex) return
        const iaEnum = await knex('ia_enum_item').select('id').where({ descr, enum_id }).first()
        if (iaEnum) return iaEnum.id
        const [result] = await knex('ia_enum_item').insert({
            descr, enum_id
        }).returning("id")
        return getId(result)
    }

    static async assertIABatchDossierEnumItemId(batch_dossier_id: number, enum_item_id: number): Promise<number> {
        if (!knex) return
        // Check or insert document
        const bachItem = await knex('ia_batch_dossier_enum_item').select('id').where({ batch_dossier_id, enum_item_id }).first()
        if (bachItem) return bachItem.id
        const [result] = await knex('ia_batch_dossier_enum_item').insert({
            batch_dossier_id, enum_item_id
        }).returning("id")
        return getId(result)
    }

    static async retrieveEnumItems(): Promise<mysqlTypes.IAEnumItem[]> {
        if (!knex) return
        const result = await knex('ia_enum as e')
            .select<mysqlTypes.IAEnumItem[]>(
                'e.id as enum_id',
                'e.descr as enum_descr',
                'ei.descr as enum_item_descr',
                'ei.hidden as enum_item_hidden',
                'ei2.descr as enum_item_descr_main'
            )
            .innerJoin('ia_enum_item as ei', 'ei.enum_id', 'e.id') // INNER JOIN
            .leftJoin('ia_enum_item as ei2', 'ei2.id', 'ei.enum_item_id_main') // LEFT JOIN
            .orderBy('e.id')
            .orderBy('ei.descr')
        return result
    }

    static async updateIAEnumItemDescrMain(enum_item_id: number, enum_item_descr_main: string | null): Promise<void> {
        if (!knex) return
        await knex('ia_enum_item').update({ enum_item_descr_main }).where({ id: enum_item_id })
    }


    static async assertIAUserId(username: string, userFields?: mysqlTypes.IAUserUpdateFields): Promise<number> {
        if (!knex) return
        const user = await knex('ia_user').select('*').where({ username }).first()
        if (user) {
            // Update user fields if provided and different from existing values
            if (userFields) {
                const updates: Partial<mysqlTypes.IAUserUpdateFields> = {}

                // Check each field and add to updates if provided and different
                if (userFields.name !== undefined && userFields.name !== user.name) {
                    updates.name = userFields.name
                }
                if (userFields.cpf !== undefined && userFields.cpf !== user.cpf) {
                    updates.cpf = userFields.cpf
                }
                if (userFields.email !== undefined && userFields.email !== user.email) {
                    updates.email = userFields.email
                }
                if (userFields.unit_id !== undefined && userFields.unit_id !== user.unit_id) {
                    updates.unit_id = userFields.unit_id
                }
                if (userFields.unit_name !== undefined && userFields.unit_name !== user.unit_name) {
                    updates.unit_name = userFields.unit_name
                }
                if (userFields.court_id !== undefined && userFields.court_id !== user.court_id) {
                    updates.court_id = userFields.court_id
                }
                if (userFields.court_name !== undefined && userFields.court_name !== user.court_name) {
                    updates.court_name = userFields.court_name
                }
                if (userFields.state_abbreviation !== undefined && userFields.state_abbreviation !== user.state_abbreviation) {
                    updates.state_abbreviation = userFields.state_abbreviation
                }

                // Perform update if there are changes
                if (Object.keys(updates).length > 0) {
                    await knex('ia_user').update(updates).where({ id: user.id })
                }
            }
            return user.id
        }
        const [result] = await knex('ia_user').insert({
            username,
            ...userFields
        }).returning('id')
        return getId(result)
    }

    static async addToIAUserDailyUsage(user_id: number, court_id: number, input_tokens_count: number, output_tokens_count: number, approximate_cost: number): Promise<void> {
        if (!knex) return
        const usage_date = new Date().toISOString().split('T')[0] // YYYY-MM-DD format
        const userDailyUsageId = await knex('ia_user_daily_usage').select('id').where({ usage_date, user_id }).first()
        if (userDailyUsageId) {
            // Update existing record
            await knex('ia_user_daily_usage').where({ id: userDailyUsageId.id }).update({
                usage_count: knex.raw('usage_count + ?', [1]),
                input_tokens_count: knex.raw('input_tokens_count + ?', [input_tokens_count]),
                output_tokens_count: knex.raw('output_tokens_count + ?', [output_tokens_count]),
                approximate_cost: knex.raw('approximate_cost + ?', [approximate_cost]),
                court_id
            })
        }
        else {
            // Insert new record
            await knex('ia_user_daily_usage').insert({
                usage_date,
                user_id,
                court_id,
                usage_count: 1,
                input_tokens_count,
                output_tokens_count,
                approximate_cost
            })
        }

        const courtDailyUsageId = await knex('ia_user_daily_usage').select('id').where({ usage_date, court_id, user_id: null }).first()
        if (courtDailyUsageId) {
            // Update existing record
            await knex('ia_user_daily_usage').where({ id: courtDailyUsageId.id }).update({
                usage_count: knex.raw('usage_count + ?', [1]),
                input_tokens_count: knex.raw('input_tokens_count + ?', [input_tokens_count]),
                output_tokens_count: knex.raw('output_tokens_count + ?', [output_tokens_count]),
                approximate_cost: knex.raw('approximate_cost + ?', [approximate_cost])
            })
        }
        else {
            // Insert new record
            await knex('ia_user_daily_usage').insert({
                usage_date,
                court_id,
                usage_count: 1,
                input_tokens_count,
                output_tokens_count,
                approximate_cost
            })
        }
    }

    static async retrieveCourtMonthlyUsage(court_id: number, startDate: string, endDate: string): Promise<mysqlTypes.CourtUsageData[]> {
        if (!knex) return [];

        const records = await knex('ia_user_daily_usage')
            .select('usage_date', 'usage_count', 'approximate_cost')
            .whereNull('user_id') // Ensures we get court-level records, not user-specific ones
            .andWhere({ court_id })
            .andWhere('usage_date', '>=', startDate)
            .andWhere('usage_date', '<', endDate)
            .orderBy('usage_date', 'asc');

        return records.map(record => ({
            date: record.usage_date.toISOString().split('T')[0], // Convert to YYYY-MM-DD format
            usage_count: Number(record.usage_count), // Ensure correct types
            approximate_cost: Number(record.approximate_cost) // Ensure correct types
        }));
    }

    static async retrieveUserMonthlyUsageByCourt(court_id: number, startDate: string, endDate: string): Promise<mysqlTypes.UserUsageData[]> {
        if (!knex) return [];

        const records = await knex('ia_user_daily_usage as udu')
            .select(
                'u.username', 'u.id as user_id',
                knex.raw('SUM(udu.usage_count) as usage_count'),
                knex.raw('SUM(udu.approximate_cost) as approximate_cost')
            )
            .join('ia_user as u', 'udu.user_id', 'u.id')
            .whereNotNull('udu.user_id')
            .andWhere('udu.court_id', court_id)
            .andWhere('udu.usage_date', '>=', startDate)
            .andWhere('udu.usage_date', '<', endDate)
            .groupBy('u.id', 'u.username')
            .orderBy('approximate_cost', 'desc');

        return records.map(record => ({
            id: record.user_id,
            username: record.username,
            usage_count: Number(record.usage_count),
            approximate_cost: Number(record.approximate_cost)
        }));
    }

    static async assertIAUserDailyUsageId(user_id: number, court_id: number): Promise<void> {
        if (!knex) return
        const usage_date = new Date().toISOString().split('T')[0] // YYYY-MM-DD format

        const userDailyUsageId = await knex('ia_user_daily_usage').select('id', 'usage_count', 'input_tokens_count', 'output_tokens_count', 'approximate_cost')
            .where({ usage_date, user_id }).first()

        const { user_usage_count, user_usage_cost, court_usage_count, court_usage_cost } = dailyLimits(court_id)

        if (userDailyUsageId) {
            if (user_usage_count && user_usage_count > 0 && userDailyUsageId.usage_count >= user_usage_count) {
                throw new Error(`Limite diário de consultas do usuário foi atingido, por favor, aguarde até amanhã para poder usar novamente.`)
            }
            if (user_usage_count && user_usage_cost > 0 && userDailyUsageId.approximate_cost >= user_usage_cost) {
                throw new Error(`Limite diário de gastos do usuário foi atingido, por favor, aguarde até amanhã para poder usar novamente.`)
            }
        }

        const courtDailyUsageId = await knex('ia_user_daily_usage').select('id', 'usage_count', 'input_tokens_count', 'output_tokens_count', 'approximate_cost')
            .where({ usage_date, court_id, user_id: null }).first()
        if (courtDailyUsageId) {
            if (court_usage_count && court_usage_count > 0 && courtDailyUsageId.usage_count >= court_usage_count) {
                throw new Error(`Limite diário de consultas do tribunal foi atingido, por favor, aguarde até amanhã para poder usar novamente.`)
            }
            if (court_usage_cost && court_usage_cost > 0 && courtDailyUsageId.approximate_cost >= court_usage_cost) {
                throw new Error(`Limite diário de gastos do tribunal foi atingido, por favor, aguarde até amanhã para poder usar novamente.`)
            }
        }
    }

    /**
     * Relatório de uso de IA agrupado por processo ou por usuário.
     * @param cpfs Lista de CPFs (sem pontuação) ou vazio para todos
     * @param startDate Data inicial (inclusive) no formato YYYY-MM-DD
     * @param endDate Data final (inclusive) no formato YYYY-MM-DD
     * @param groupBy 'process' | 'user'
     */
    static async retrieveIAUsageReport(params: { processes?: string[], cpfs?: string[], startDate?: string, endDate?: string, groupBy: 'process' | 'user' }): Promise<mysqlTypes.IAUsageReportRow[]> {
        if (!knex) return []
        const { processes, cpfs, startDate, endDate, groupBy } = params
        const g = knex('ia_generation as g')
            .leftJoin('ia_dossier as d', 'd.id', 'g.dossier_id')
            .leftJoin('ia_user as u', 'u.id', 'g.created_by')
            .select(
                knex.raw('u.id as user_id'),
                knex.raw('u.username as username'),
                knex.raw('u.name as user_name'),
                knex.raw('u.cpf as cpf'),
                knex.raw('d.id as dossier_id'),
                knex.raw('d.code as dossier_code'),
                knex.raw('MIN(g.created_at) as first_generation_at'),
                knex.raw('MAX(g.created_at) as last_generation_at'),
                knex.raw('COUNT(g.id) as generations_count'),
                knex.raw('COALESCE(SUM(g.approximate_cost),0) as approximate_cost_sum')
            )
            .whereNotNull('g.dossier_id')

        if (processes && processes.length > 0) {
            g.whereIn('d.code', processes)
        }
        if (cpfs && cpfs.length > 0) {
            g.whereIn('u.cpf', cpfs.map(c => c.trim()))
        }
        if (startDate) {
            g.andWhere('g.created_at', '>=', startDate + ' 00:00:00')
        }
        if (endDate) {
            g.andWhere('g.created_at', '<=', endDate + ' 23:59:59')
        }

        g.groupBy('d.id', 'd.code', 'u.id', 'u.username', 'u.name', 'u.cpf')

        if (groupBy === 'process') {
            g.orderBy('d.code').orderBy('u.name')
        } else {
            g.orderBy('u.name').orderBy('d.code')
        }

        // console.log('SQL:', g.toQuery())
        const rows: any[] = await g

        return rows.map(r => ({
            user_id: r.user_id ? Number(r.user_id) : null,
            username: r.username ?? null,
            user_name: r.user_name ?? null,
            dossier_id: r.dossier_id ? Number(r.dossier_id) : null,
            dossier_code: r.dossier_code ?? null,
            first_generation_at: r.first_generation_at ? new Date(r.first_generation_at) : null,
            last_generation_at: r.last_generation_at ? new Date(r.last_generation_at) : null,
            generations_count: Number(r.generations_count) || 0,
            approximate_cost_sum: Number(r.approximate_cost_sum) || 0,
            user_cpf: r.cpf ?? null,
        })) as any
    }

    static async retrieveIAUsageDetail(params: { dossier_code: string, user_cpf?: string, startDate?: string, endDate?: string, isModerator: boolean, currentUserCpf?: string }): Promise<mysqlTypes.IAUsageDetailRow[]> {
        if (!knex) return []
        const { dossier_code, user_cpf, startDate, endDate, isModerator, currentUserCpf } = params
        const q = knex('ia_generation as g')
            .leftJoin('ia_dossier as d', 'd.id', 'g.dossier_id')
            .leftJoin('ia_user as u', 'u.id', 'g.created_by')
            .select(
                'g.id as id',
                'd.code as dossier_code',
                'u.id as user_id',
                'u.username as username',
                'u.name as user_name',
                'u.cpf as user_cpf',
                'g.created_at as created_at',
                'g.generation as generation',
                'g.prompt_payload as prompt_payload',
                'g.approximate_cost as approximate_cost',
                'g.model as model',
                'g.prompt as prompt'
            )
            .where('d.code', dossier_code)
            .whereNotNull('g.dossier_id')

        if (startDate) q.andWhere('g.created_at', '>=', startDate + ' 00:00:00')
        if (endDate) q.andWhere('g.created_at', '<=', endDate + ' 23:59:59')

        if (isModerator) {
            if (user_cpf) q.andWhere('u.cpf', user_cpf)
        } else {
            const enforcedCpf = (currentUserCpf || '').replace(/\D/g, '')
            if (!enforcedCpf) return []
            q.andWhere('u.cpf', enforcedCpf)
        }

        q.orderBy('g.created_at', 'asc')
        const rows: any[] = await q
        return rows.map(r => ({
            id: Number(r.id),
            dossier_code: r.dossier_code ?? null,
            user_id: r.user_id ? Number(r.user_id) : null,
            username: r.username ?? null,
            user_name: r.user_name ?? null,
            user_cpf: r.user_cpf ?? null,
            created_at: r.created_at ? new Date(r.created_at) : null,
            generation: r.generation ?? null,
            prompt_payload: r.prompt_payload ?? null,
            approximate_cost: r.approximate_cost != null ? Number(r.approximate_cost) : null,
            model: r.model ?? null,
            prompt: r.prompt ?? null,
        }))
    }

    static async createBatchWithJobs(params: { name: string, tipo_de_sintese: string, complete: boolean, numbers: string[] }): Promise<mysqlTypes.IABatch> {
        const userId = await getCurrentUserId()
        const { name, tipo_de_sintese, complete, numbers } = params
        const [batchIdRet] = await knex('ia_batch').insert({ name, created_by: userId, tipo_de_sintese, complete, paused: true }).returning('id')
        const batch_id = getId(batchIdRet)
        const rows = numbers
            .map(n => (n || '').replace(/\D/g, ''))
            .filter(n => n && n.length === 20)
            .map(n => ({ batch_id, dossier_code: n }))
        if (rows.length) await knex('ia_batch_job').insert(rows)
        const batch = await knex('ia_batch').select('*').where({ id: batch_id }).first()
        return batch as mysqlTypes.IABatch
    }

    static async listBatchesForUser(): Promise<mysqlTypes.IABatchSummary[]> {
        const userId = await getCurrentUserId()
        // Aggregate counts and cost in a single query per batch
        const batches: any[] = await knex('ia_batch as b')
            .select('b.id', 'b.name', 'b.tipo_de_sintese', 'b.complete', 'b.paused')
            .where('b.created_by', userId)
            .orderBy('b.created_at', 'desc')
        if (!batches.length) return []
        const batchIds = batches.map(b => b.id)
        const jobs = await knex('ia_batch_job')
            .select('batch_id', 'status')
            .count('* as cnt')
            .whereIn('batch_id', batchIds)
            .groupBy('batch_id', 'status')
        const costs = await knex('ia_batch_job')
            .select('batch_id')
            .sum({ sum: 'cost_sum' })
            .whereIn('batch_id', batchIds)
            .andWhere('status', 'READY')
            .groupBy('batch_id')
        const durations = await knex('ia_batch_job')
            .select('batch_id')
            .avg({ avg: 'duration_ms' })
            .whereIn('batch_id', batchIds)
            .andWhere('status', 'READY')
            .groupBy('batch_id')
        const byId: Record<number, mysqlTypes.IABatchSummary> = {}
        for (const b of batches) {
            byId[b.id] = { id: b.id, name: b.name, tipo_de_sintese: b.tipo_de_sintese, complete: !!b.complete, paused: !!b.paused, totals: { total: 0, pending: 0, running: 0, ready: 0, error: 0 }, spentCost: 0, estimatedTotalCost: 0, avgDurationMs: null, etaMs: null }
        }
        for (const jAny of jobs as any[]) {
            const s = jAny.status as mysqlTypes.IABatchJob['status']
            const cnt = Number(jAny.cnt)
            const agg = byId[jAny.batch_id]
            if (!agg) continue
            agg.totals.total += cnt
            if (s === 'PENDING') agg.totals.pending += cnt
            if (s === 'RUNNING') agg.totals.running += cnt
            if (s === 'READY') agg.totals.ready += cnt
            if (s === 'ERROR') agg.totals.error += cnt
        }
        for (const cAny of costs as any[]) {
            const agg = byId[cAny.batch_id]
            if (!agg) continue
            agg.spentCost = Number(cAny.sum || 0)
        }
        for (const dAny of durations as any[]) {
            const agg = byId[dAny.batch_id]
            if (!agg) continue
            agg.avgDurationMs = dAny.avg != null ? Number(dAny.avg) : null
        }
        // Estimate total cost: avg cost of READY * total jobs
        for (const id of Object.keys(byId)) {
            const agg = byId[Number(id)]
            const ready = Math.max(1, agg.totals.ready)
            const avgCost = agg.spentCost / ready
            agg.estimatedTotalCost = Number.isFinite(avgCost) ? avgCost * agg.totals.total : agg.spentCost
            const remaining = agg.totals.total - agg.totals.ready - agg.totals.error
            agg.etaMs = agg.avgDurationMs ? Math.round(agg.avgDurationMs * Math.max(remaining, 0)) : null
        }
        return Object.values(byId)
    }

    static async getBatchSummary(batch_id: number): Promise<mysqlTypes.IABatchSummary | undefined> {
        const b = await knex('ia_batch').select('*').where({ id: batch_id }).first()
        if (!b) return
        const counts = await knex('ia_batch_job')
            .select('status')
            .count('* as cnt')
            .where({ batch_id })
            .groupBy('status')
        // Custo atual: soma de approximate_cost das gerações vinculadas ao lote
        const costRow = await knex('ia_batch_dossier_item as bdi')
            .innerJoin('ia_generation as g', 'g.id', 'bdi.generation_id')
            .innerJoin('ia_batch_dossier as bd', 'bd.id', 'bdi.batch_dossier_id')
            .sum({ sum: 'g.approximate_cost' })
            .where('bd.batch_id', batch_id)
            .first()
        const durRow = await knex('ia_batch_job')
            .avg({ avg: 'duration_ms' })
            .where({ batch_id, status: 'READY' })
            .first()
        const totals = { total: 0, pending: 0, running: 0, ready: 0, error: 0 }
        ;(counts as any[]).forEach(c => {
            const s = c.status as mysqlTypes.IABatchJob['status']
            const cnt = Number(c.cnt)
            totals.total += cnt
            if (s === 'PENDING') totals.pending += cnt
            if (s === 'RUNNING') totals.running += cnt
            if (s === 'READY') totals.ready += cnt
            if (s === 'ERROR') totals.error += cnt
        })
    const spentCost = Number((costRow as any)?.sum || 0)
    const avgDurationMs = (durRow as any)?.avg != null ? Number((durRow as any).avg) : null
    // Média por dossiê (job) pronto, não por item; garante estimado >= atual quando há pendentes
    const readyCount = Math.max(1, totals.ready)
    const avgCost = spentCost / readyCount
    const estimatedTotalCost = Number.isFinite(avgCost) ? avgCost * totals.total : spentCost
        const remaining = totals.total - totals.ready - totals.error
        const etaMs = avgDurationMs ? Math.round(avgDurationMs * Math.max(remaining, 0)) : null
        return { id: b.id, name: b.name, tipo_de_sintese: b.tipo_de_sintese, complete: !!b.complete, paused: !!b.paused, totals, spentCost, estimatedTotalCost, avgDurationMs, etaMs }
    }

    static async listBatchJobs(batch_id: number, status?: mysqlTypes.IABatchJob['status'] | 'all', page?: number, pageSize: number = 50): Promise<mysqlTypes.IABatchJob[]> {
        const q = knex('ia_batch_job').select('*').where({ batch_id })
        if (status && status !== 'all') q.andWhere('status', status)
        q.orderBy('created_at', 'asc').limit(pageSize).offset(((page || 1) - 1) * pageSize)
        const rows = await q
        return rows as any
    }

    static async setBatchPaused(batch_id: number, paused: boolean): Promise<void> {
        await knex('ia_batch').update({ paused }).where({ id: batch_id })
    }

    static async assertBatchOwnership(batch_id: number): Promise<boolean> {
        const userId = await getCurrentUserId()
        const row = await knex('ia_batch').select('id').where({ id: batch_id, created_by: userId }).first()
        return !!row
    }

    static async findBatchDossierByBatchAndCode(batch_id: number, dossier_code: string): Promise<{ batch_dossier_id: number, dossier_id: number } | undefined> {
        const row = await knex('ia_batch_dossier as bd')
            .select('bd.id as batch_dossier_id', 'd.id as dossier_id')
            .innerJoin('ia_dossier as d', 'd.id', 'bd.dossier_id')
            .where('bd.batch_id', batch_id)
            .andWhere('d.code', dossier_code)
            .first()
        if (!row) return
        return { batch_dossier_id: (row as any).batch_dossier_id, dossier_id: (row as any).dossier_id }
    }

    static async computeCostSumByBatchDossierId(batch_dossier_id: number): Promise<number> {
        const row = await knex('ia_batch_dossier_item as bdi')
            .leftJoin('ia_generation as g', 'g.id', 'bdi.generation_id')
            .where('bdi.batch_dossier_id', batch_dossier_id)
            .sum({ sum: 'g.approximate_cost' })
            .first()
        return Number((row as any)?.sum || 0)
    }

    static async stepBatch(batch_id: number, fnProcess: (job: mysqlTypes.IABatchJob) => Promise<{ status: 'READY' | 'ERROR', error_msg?: string, cost_sum?: number, dossier_id?: number }>, opts?: { job_id?: number, dossier_code?: string }): Promise<mysqlTypes.IABatchJob | undefined> {
        // Find one pending job: if opts.job_id provided, target by id; else if dossier_code provided, target by dossier; otherwise FIFO
        const q = knex('ia_batch_job').select('*').where({ batch_id, status: 'PENDING' })
        if (opts?.job_id) q.andWhere('id', opts.job_id)
        else if (opts?.dossier_code) q.andWhere('dossier_code', opts.dossier_code)
        const job = await q.orderBy('created_at', 'asc').first()
        if (!job) return
        const started_at = new Date()
        await knex('ia_batch_job').update({ status: 'RUNNING', started_at, attempts: knex.raw('attempts + 1') }).where({ id: job.id })
        try {
            const result = await fnProcess(job as mysqlTypes.IABatchJob)
            const finished_at = new Date()
            const duration_ms = finished_at.getTime() - started_at.getTime()
            let cost_sum = result.cost_sum ?? job.cost_sum
            let dossier_id = result.dossier_id ?? job.dossier_id
            if (result.status === 'READY') {
                // Try compute cost and dossier_id from persisted batch_dossier
                const bd = await this.findBatchDossierByBatchAndCode(batch_id, (job as any).dossier_code)
                if (bd) {
                    dossier_id = bd.dossier_id
                    cost_sum = await this.computeCostSumByBatchDossierId(bd.batch_dossier_id)
                }
            }
            await knex('ia_batch_job').update({ status: result.status, finished_at, duration_ms, error_msg: result.error_msg || null, cost_sum, dossier_id }).where({ id: job.id })
            await knex('ia_batch').update({ last_activity_at: new Date() }).where({ id: batch_id })
            const updated = await knex('ia_batch_job').select('*').where({ id: job.id }).first()
            return updated as any
        } catch (e) {
            const finished_at = new Date()
            const duration_ms = finished_at.getTime() - started_at.getTime()
            await knex('ia_batch_job').update({ status: 'ERROR', finished_at, duration_ms, error_msg: (e as Error).message || String(e) }).where({ id: job.id })
            await knex('ia_batch').update({ last_activity_at: new Date() }).where({ id: batch_id })
            const updated = await knex('ia_batch_job').select('*').where({ id: job.id }).first()
            return updated as any
        }
    }

    static async retryJob(batch_id: number, job_id: number): Promise<void> {
        await knex('ia_batch_job').update({ status: 'PENDING', error_msg: null, started_at: null, finished_at: null, duration_ms: null }).where({ id: job_id, batch_id })
    }

    static async addJobs(batch_id: number, numbers: string[]): Promise<number> {
        const rows = numbers
            .map(n => (n || '').replace(/\D/g, ''))
            .filter(n => n && n.length === 20)
            .map(n => ({ batch_id, dossier_code: n }))
        if (!rows.length) return 0
        const inserted = await knex('ia_batch_job').insert(rows).returning('id')
        return Array.isArray(inserted) ? inserted.length : 0
    }

    static async deleteJobs(batch_id: number, numbers: string[]): Promise<number> {
        const cleaned = numbers.map(n => (n || '').replace(/\D/g, '')).filter(n => n && n.length === 20)
        if (!cleaned.length) return 0
        let totalDeleted = 0
        for (const code of cleaned) {
            const deleted = await this.deleteJobDeep(batch_id, code)
            totalDeleted += deleted
        }
        return totalDeleted
    }

    static async getErrorsCsv(batch_id: number): Promise<string> {
        const rows = await knex('ia_batch_job').select('dossier_code', 'attempts', 'error_msg', 'started_at', 'finished_at', 'duration_ms').where({ batch_id, status: 'ERROR' }).orderBy('finished_at', 'desc')
        const header = 'dossier_code;attempts;error_msg;started_at;finished_at;duration_ms\n'
        const body = rows.map(r => [r.dossier_code, r.attempts, (r.error_msg || '').replace(/[\r\n]+/g, ' '), r.started_at ? new Date(r.started_at).toISOString() : '', r.finished_at ? new Date(r.finished_at).toISOString() : '', r.duration_ms ?? ''].join(';')).join('\n')
        return header + body + '\n'
    }

    // Delete a job and its batch dossier links (if any), as long as it's not RUNNING
    static async deleteJobDeep(batch_id: number, dossier_code: string): Promise<number> {
        return await knex.transaction(async (trx) => {
            // Only allow delete when not RUNNING
            const job = await trx('ia_batch_job').select('id', 'status').where({ batch_id, dossier_code }).first()
            if (!job) return 0
            if ((job as any).status === 'RUNNING') return 0

            // Find batch_dossier ids for this batch + dossier_code
            const bdRows = await trx('ia_batch_dossier as bd')
                .select('bd.id')
                .innerJoin('ia_dossier as d', 'd.id', 'bd.dossier_id')
                .where('bd.batch_id', batch_id)
                .andWhere('d.code', dossier_code)

            const bdIds = bdRows.map(r => (r as any).id)
            if (bdIds.length) {
                await trx('ia_batch_dossier_item').whereIn('batch_dossier_id', bdIds).delete()
                await trx('ia_batch_dossier').whereIn('id', bdIds).delete()
            }

            const del = await trx('ia_batch_job').where({ batch_id, dossier_code }).andWhereNot({ status: 'RUNNING' }).delete()
            return del
        })
    }

    // Backfill helper: for READY jobs missing cost_sum, compute from persisted generations and save it.
    static async backfillJobCost(batch_id: number, job_id: number, dossier_code: string): Promise<number | null> {
        const bd = await this.findBatchDossierByBatchAndCode(batch_id, dossier_code)
        if (!bd) return null
        const cost = await this.computeCostSumByBatchDossierId(bd.batch_dossier_id)
        await knex('ia_batch_job').update({ cost_sum: cost, dossier_id: bd.dossier_id }).where({ id: job_id, batch_id })
        return cost
    }
}

