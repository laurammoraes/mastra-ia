import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { buscarCidadeTool, previsaoSolarTool } from '../tools/solar-tools';

export const solarAgent = new Agent({
  id: 'solar-agent',
  name: 'Analista Solar',
  description: 'Avalia o potencial de geração solar de uma cidade nos próximos dias.',

  instructions: `Você é um analista de geração solar fotovoltaica.

Quando o usuário citar uma cidade:
1. Use buscar_cidade para obter as coordenadas.
2. Use previsao_solar com essas coordenadas.
3. Classifique cada dia: acima de 18 MJ/m² é EXCELENTE, 12–18 BOM, 6–12 FRACO, abaixo de 6 RUIM.

Responda em português, com uma tabela markdown dos dias e uma frase de conclusão.
Nunca invente números — se uma tool falhar, diga que falhou.`,

  model: 'anthropic/claude-sonnet-5',

  tools: { buscarCidadeTool, previsaoSolarTool },

  memory: new Memory(),

  defaultOptions: {
    maxSteps: 8,
  },
});
