import { Dao } from "../db/mysql"
import { IALibrary, IALibraryInclusion } from "../db/mysql-types"

/**
 * Obtém e formata os documentos da biblioteca do usuário atual para inclusão em prompts.
 * 
 * Documentos com inclusion='SIM' são incluídos com seu conteúdo completo.
 * Documentos com inclusion='CONTEXTUAL' são listados apenas com suas referências e contexto.
 * 
 * @returns String formatada com os documentos da biblioteca
 */
export async function getLibraryDocumentsForPrompt(): Promise<string> {
    try {
        // Busca todos os documentos da biblioteca do usuário
        const documents: IALibrary[] = await Dao.listLibrary()

        // Filtra documentos que não são binários e que têm conteúdo
        const validDocuments = documents.filter(doc =>
            doc.content_markdown &&
            doc.kind !== 'ARQUIVO'
        )

        // Separa documentos por tipo de inclusão
        const alwaysInclude = validDocuments.filter(doc =>
            doc.inclusion === IALibraryInclusion.SIM
        )

        const contextualDocuments = validDocuments.filter(doc =>
            doc.inclusion === IALibraryInclusion.CONTEXTUAL
        )

        let result = `# Biblioteca de Documentos do Usuário \n\n`

        // Adiciona documentos com inclusão automática
        if (alwaysInclude.length > 0) {
            result += '## Referências da Biblioteca\n\n'
            result += 'Os seguintes documentos são referência obrigatória para execução da tarefa:\n\n'

            for (const doc of alwaysInclude) {
                result += `<library-document id="${doc.id}" title="${doc.title}">\n${doc.content_markdown}\n</library-document>\n\n`
            }
        }

        // Adiciona documentos contextuais
        if (contextualDocuments.length > 0) {
            if (result) result += '\n'

            result += `## Outros Documentos Disponíveis
Os seguintes documentos estão disponíveis na biblioteca e devem ser carregados conforme o contexto da solicitação:\n\n`

            for (const doc of contextualDocuments) {
                const context = doc.context ? ` context="${doc.context}"` : ''
                result += `<library-document id="${doc.id}" title="${doc.title}"${context} />\n\n`
            }
            result += '\n'
        }

        return result
    } catch (error) {
        console.error('Error getting library documents for prompt:', error)
        return ''
    }
}

export type LibraryDocumentsType = {
    included: string,
    available: string
}

export async function getLibraryDocuments(): Promise<LibraryDocumentsType> {
    try {
        // Busca todos os documentos da biblioteca do usuário
        const documents: IALibrary[] = await Dao.listLibrary()

        // Filtra documentos que não são binários e que têm conteúdo
        const validDocuments = documents.filter(doc =>
            doc.content_markdown &&
            doc.kind !== 'ARQUIVO'
        )

        // Separa documentos por tipo de inclusão
        const alwaysInclude = validDocuments.filter(doc =>
            doc.inclusion === IALibraryInclusion.SIM
        )

        const contextualDocuments = validDocuments.filter(doc =>
            doc.inclusion === IALibraryInclusion.CONTEXTUAL
        )

        // Adiciona documentos com inclusão automática
        let included = ``
        if (alwaysInclude.length > 0) {
            for (const doc of alwaysInclude) {
                included += `<library-document id="${doc.id}">\n${doc.content_markdown}\n</library-document>\n\n`
            }
        }

        // Adiciona documentos contextuais
        let available = ``
        if (contextualDocuments.length > 0) {
            for (const doc of contextualDocuments) {
                const context = doc.context ? ` context="${doc.context}"` : ''
                available += `<library-document id="${doc.id}" title="${doc.title}"${context} />\n\n`
            }
        }

        return { included, available }
    } catch (error) {
        console.error('Error getting library documents for prompt:', error)
        return { included: '', available: '' }
    }
}


/**
 * Formata um documento específico da biblioteca para inclusão em um prompt.
 * 
 * @param documentId - ID do documento a ser formatado
 * @returns String formatada com o documento ou mensagem de erro
 */
export async function getLibraryDocumentFormatted(documentId: number): Promise<string> {
    try {
        const document: IALibrary | undefined = await Dao.getLibraryById(documentId)

        if (!document) {
            return `Erro: Documento com ID ${documentId} não encontrado ou sem permissão de acesso.`
        }

        if (document.kind === 'ARQUIVO' && document.content_binary) {
            return `Erro: O documento "${document.title}" é um arquivo binário e não pode ser processado como texto.`
        }

        if (!document.content_markdown) {
            return `Erro: O documento "${document.title}" não possui conteúdo de texto.`
        }

        return `<library id="${document.id}" title="${document.title}">\n${document.content_markdown}\n</library>`
    } catch (error) {
        console.error('Error getting formatted library document:', error)
        return `Erro ao obter documento ${documentId}: ${error instanceof Error ? error.message : 'Unknown error'}`
    }
}
