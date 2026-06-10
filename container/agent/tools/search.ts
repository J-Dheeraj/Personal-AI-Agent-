import { Mnemon } from '../mnemon';

export async function searchKnowledge(query: string, mnemon: Mnemon): Promise<string> {
  const facts = await mnemon.semanticSearch(query);
  if (!facts.length) return 'No relevant information found in knowledge graph.';
  return facts.join('\n');
}
