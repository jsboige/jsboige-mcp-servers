import { decode } from 'html-entities'

/**
 * Types pour le contenu des messages assistant
 */
export interface TextContent {
  type: "text"
  content: string
  partial: boolean
}

export interface ToolUse {
  type: "tool_use"
  name: string
  params: Record<string, string>
  partial: boolean
}

export type AssistantMessageContent = TextContent | ToolUse

/**
 * Liste complète des noms de paramètres d'outils Roo
 * Basé sur les 38 toolParamNames mentionnés dans la documentation
 */
const toolParamNames = [
  // Outils de lecture
  'path', 'line_range', 'paths', 'file',
  
  // Outils d'écriture
  'content', 'line_count', 'diff', 'line',
  
  // Outils de recherche
  'regex', 'file_pattern', 'query', 'search', 'replace',
  'use_regex', 'ignore_case', 'start_line', 'end_line',
  
  // Outils de commande
  'command', 'cwd',
  
  // MCP
  'server_name', 'tool_name', 'arguments', 'uri',
  
  // Questions et complétion
  'question', 'follow_up', 'suggest', 'result',
  
  // Mode switching
  'mode_slug', 'mode', 'reason', 'message',
  
  // Todo list
  'todos',
  
  // Autres paramètres courants
  'args', 'task', 'recursive', 'index',
  'timeout', 'preview'
] as const

/**
 * Parse un message assistant contenant du XML
 * Adapté de la logique V1 de Roo pour parser les tool_use et le texte
 * 
 * @param message - Le message brut à parser
 * @returns Array de blocs de contenu (text ou tool_use)
 */
export function parseAssistantMessage(message: string): AssistantMessageContent[] {
  const blocks: AssistantMessageContent[] = []
  let i = 0
  let currentText = ''
  
  while (i < message.length) {
    // Chercher le début d'une balise d'outil
    const toolStart = message.indexOf('<', i)
    
    if (toolStart === -1) {
      // Plus de balises, ajouter le reste comme texte
      currentText += message.slice(i)
      break
    }
    
    // Ajouter le texte avant la balise
    if (toolStart > i) {
      currentText += message.slice(i, toolStart)
    }
    
    // Vérifier si c'est une balise d'outil valide
    const nextChar = message[toolStart + 1]
    if (!nextChar || nextChar === '/' || nextChar === '!' || nextChar === '?') {
      // Pas une balise d'ouverture d'outil, continuer
      currentText += '<'
      i = toolStart + 1
      continue
    }
    
    // Extraire le nom de l'outil
    let toolNameEnd = toolStart + 1
    while (toolNameEnd < message.length && 
           message[toolNameEnd] !== '>' && 
           message[toolNameEnd] !== ' ' &&
           message[toolNameEnd] !== '\n') {
      toolNameEnd++
    }
    
    const toolName = message.slice(toolStart + 1, toolNameEnd)
    
    // Vérifier si c'est un outil Roo connu (doit contenir _ ou être un nom connu)
    if (!toolName.includes('_') && !['args', 'file', 'path', 'task'].includes(toolName)) {
      currentText += '<'
      i = toolStart + 1
      continue
    }
    
    // Trouver la fin de la balise ouvrante
    const openTagEnd = message.indexOf('>', toolNameEnd)
    if (openTagEnd === -1) {
      currentText += '<'
      i = toolStart + 1
      continue
    }
    
    // Trouver la balise fermante correspondante
    const closeTag = `</${toolName}>`
    let closeTagStart = message.indexOf(closeTag, openTagEnd + 1)
    
    // Gestion spéciale pour write_to_file : chercher depuis la fin
    if (toolName === 'write_to_file' && closeTagStart !== -1) {
      // Utiliser lastIndexOf pour trouver la vraie balise fermante
      const lastClose = message.lastIndexOf(closeTag)
      if (lastClose > closeTagStart) {
        closeTagStart = lastClose
      }
    }
    
    if (closeTagStart === -1) {
      currentText += '<'
      i = toolStart + 1
      continue
    }
    
    // Flush le texte accumulé avant d'ajouter le tool_use
    if (currentText.trim()) {
      blocks.push({
        type: 'text',
        content: currentText,
        partial: false
      })
      currentText = ''
    }
    
    // Extraire le contenu de l'outil
    const toolContent = message.slice(openTagEnd + 1, closeTagStart)
    
    // Parser les paramètres
    const params: Record<string, string> = {}
    
    for (const paramName of toolParamNames) {
      const paramStart = toolContent.indexOf(`<${paramName}>`)
      if (paramStart === -1) continue
      
      const paramContentStart = paramStart + paramName.length + 2
      const paramEnd = toolContent.indexOf(`</${paramName}>`, paramContentStart)
      
      if (paramEnd === -1) continue
      
      let paramValue = toolContent.slice(paramContentStart, paramEnd)
      
      // Préserver les newlines pour le paramètre 'content'
      if (paramName === 'content') {
        // Ne pas trim pour préserver la structure
        params[paramName] = paramValue
      } else {
        // Pour les autres paramètres, normaliser
        params[paramName] = paramValue.trim()
      }
    }
    
    // Ajouter le bloc tool_use
    blocks.push({
      type: 'tool_use',
      name: toolName,
      params,
      partial: false
    })
    
    // Avancer après la balise fermante
    i = closeTagStart + closeTag.length
  }
  
  // Ajouter le texte final s'il existe
  if (currentText.trim()) {
    blocks.push({
      type: 'text',
      content: currentText,
      partial: false
    })
  }
  
  return blocks
}

/**
 * Parse un message assistant encodé en HTML
 * 
 * Cette fonction:
 * 1. Décode les entités HTML (&lt; → <, &gt; → >, etc.)
 * 2. Parse le XML avec la logique Roo V1
 * 3. Force partial = false (messages complets)
 * 
 * @param encodedMessage - Message avec entités HTML encodées
 * @returns Array de blocs de contenu parsés
 */
export function parseEncodedAssistantMessage(encodedMessage: string): AssistantMessageContent[] {
  // Décoder les entités HTML
  const decoded = decode(encodedMessage)
  
  // Parser avec logique Roo
  const blocks = parseAssistantMessage(decoded)
  
  // Forcer partial = false (messages complets du JSON)
  return blocks.map(block => ({
    ...block,
    partial: false
  }))
}