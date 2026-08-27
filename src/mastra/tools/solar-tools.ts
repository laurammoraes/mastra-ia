import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

/**
 * Tool 1: resolve um nome de cidade em coordenadas.
 * O agente precisa chamar esta antes da previsão — ele descobre isso sozinho
 * porque a `description` da tool 2 exige lat/lon.
 */
export const buscarCidadeTool = createTool({
  id: 'buscar_cidade',
  description: 'Converte o nome de uma cidade em latitude e longitude. Use antes de consultar a previsão solar.',
  inputSchema: z.object({
    cidade: z.string().describe('Nome da cidade, ex: "Florianópolis"'),
  }),
  outputSchema: z.object({
    nome: z.string(),
    estado: z.string(),
    latitude: z.number(),
    longitude: z.number(),
  }),
  execute: async ({ cidade }) => {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cidade)}&count=1&language=pt`;
    const data = (await (await fetch(url)).json()) as {
      results?: { name: string; admin1: string; latitude: number; longitude: number }[];
    };

    const hit = data.results?.[0];
    if (!hit) throw new Error(`Cidade "${cidade}" não encontrada.`);

    return { nome: hit.name, estado: hit.admin1, latitude: hit.latitude, longitude: hit.longitude };
  },
});

/**
 * Tool 2: irradiação solar diária para um par de coordenadas.
 */
export const previsaoSolarTool = createTool({
  id: 'previsao_solar',
  description:
    'Retorna a irradiação solar diária (MJ/m²), horas de sol e cobertura de nuvens para uma coordenada. Requer latitude e longitude.',
  inputSchema: z.object({
    latitude: z.number(),
    longitude: z.number(),
    dias: z.number().min(1).max(7).default(3).describe('Quantos dias de previsão'),
  }),
  outputSchema: z.object({
    dias: z.array(
      z.object({
        data: z.string(),
        irradiacaoMJ: z.number(),
        horasDeSol: z.number(),
        nuvensPercent: z.number(),
      }),
    ),
  }),
  execute: async ({ latitude, longitude, dias }) => {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
      `&daily=shortwave_radiation_sum,sunshine_duration,cloud_cover_mean&forecast_days=${dias}&timezone=auto`;

    const data = (await (await fetch(url)).json()) as {
      daily: {
        time: string[];
        shortwave_radiation_sum: number[];
        sunshine_duration: number[];
        cloud_cover_mean: number[];
      };
    };

    return {
      dias: data.daily.time.map((data_, i) => ({
        data: data_,
        irradiacaoMJ: data.daily.shortwave_radiation_sum[i],
        horasDeSol: Number((data.daily.sunshine_duration[i] / 3600).toFixed(1)),
        nuvensPercent: data.daily.cloud_cover_mean[i],
      })),
    };
  },
});
