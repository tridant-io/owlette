import type { MetadataRoute } from 'next';
import { source } from '@/lib/source';

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = 'https://owlette.app';

  return [
    {
      url: baseUrl,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 1,
    },
    {
      url: `${baseUrl}/for-ai`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.5,
    },
    {
      url: `${baseUrl}/login`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.5,
    },
    {
      url: `${baseUrl}/register`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.7,
    },
    {
      url: `${baseUrl}/demo`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    ...source.getPages().map((page) => ({
      url: `${baseUrl}${page.url}`,
      changeFrequency: 'weekly' as const,
      priority: 0.6,
    })),
    ...['/privacy', '/terms', '/legal/dmca'].map((path) => ({
      url: `${baseUrl}${path}`,
      changeFrequency: 'yearly' as const,
      priority: 0.2,
    })),
  ];
}
