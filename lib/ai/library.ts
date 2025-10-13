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
export async function getLibraryDocumentsForPrompt(ids: string[] | undefined): Promise<string> {
    try {
        const lib = await getLibraryDocuments(ids)

        let result = `# Biblioteca de Documentos do Usuário \n\n`

        // Adiciona documentos com inclusão automática
        if (lib.included.length > 0) {
            result += `Os seguintes documentos são referência obrigatória para execução da tarefa, o conteúdo completo de cada documento está disponível entre <library-document> e </library-document>:\n\n`
            result += lib.included
        } else {
            result += `O usuário não selecionou nenhum documento.\n\n`
        }

        // Adiciona documentos contextuais
        if (lib.available.length > 0) {
            result += `Os seguintes documentos estão disponíveis na biblioteca e devem ser carregados conforme o contexto da solicitação:\n\n`
            result += `<library-refs>\n`
            result += lib.available
            result += `</library-refs>\n`
        } else {
            result += `Não existem documentos disponíveis para serem incluídos em função do contexto.\n\n`
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

export async function getLibraryDocuments(ids: string[] | undefined): Promise<LibraryDocumentsType> {
    try {
        const numericIds = ids ? ids.map(id => parseInt(id)).filter(id => !isNaN(id)) : []

        // Busca todos os documentos da biblioteca do usuário
        const documents: IALibrary[] = await Dao.listLibrary()

        // Filtra documentos que têm conteúdo
        const validDocuments = documents.filter(doc => doc.content_markdown)

        // Separa documentos por tipo de inclusão
        const alwaysInclude = validDocuments.filter(doc =>
            doc.inclusion === IALibraryInclusion.SIM && ids === undefined || numericIds.includes(doc.id)
        )

        const contextualDocuments = validDocuments.filter(doc =>
            doc.inclusion === IALibraryInclusion.CONTEXTUAL && !numericIds.includes(doc.id)
        )

        // Adiciona documentos com inclusão automática
        let included = ``
        if (alwaysInclude.length > 0) {
            for (const doc of alwaysInclude) {
                included += `<library-document title="${doc.title}">\n${doc.content_markdown}\n</library-document>\n\n`
            }
        }

        // Adiciona documentos contextuais
        let available = ``
        if (contextualDocuments.length > 0) {
            for (const doc of contextualDocuments) {
                const context = doc.context ? ` context="${doc.context}"` : ''
                available += `<library-ref id="${doc.id}" title="${doc.title}"${context} />\n\n`
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
