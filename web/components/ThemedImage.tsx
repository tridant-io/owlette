import Image, { getImageProps, type ImageProps } from 'next/image';
import { preload as preloadResource } from 'react-dom';
import { cn } from '@/lib/utils';

type ThemedImageProps = Omit<ImageProps, 'src' | 'priority' | 'loading'> & {
  dark: string;
  /** the dark path until a light capture exists */
  light: string;
};

const SCHEMES = ['dark', 'light'] as const;

/**
 * a screenshot captured once per theme. both images render and the theme class
 * shows one. both load lazily: a lazy image under `display: none` never nears the
 * viewport, so the hidden capture is never fetched, where an eager one would be.
 *
 * `preload` can't pass straight through for the same reason: a plain preload
 * fetches whatever the display. each capture gets a preload scoped to
 * `prefers-color-scheme` instead, which matches what most visitors see, since
 * the theme follows the os unless a user pins one.
 */
export function ThemedImage({ dark, light, alt, preload = false, className, ...rest }: ThemedImageProps) {
  // until a light capture exists the pair is one image, rendered exactly as before
  if (dark === light) {
    return <Image {...rest} src={dark} alt={alt} preload={preload} className={className} />;
  }

  if (preload) {
    for (const scheme of SCHEMES) {
      const { props } = getImageProps({ ...rest, alt, src: scheme === 'dark' ? dark : light });
      preloadResource(props.src, {
        as: 'image',
        imageSrcSet: props.srcSet,
        imageSizes: props.sizes,
        // a preloaded capture is the page's largest paint; both images are lazy,
        // so the preload is what fetches it first
        fetchPriority: 'high',
        media: `(prefers-color-scheme: ${scheme})`,
      });
    }
  }

  return (
    <>
      <Image {...rest} src={dark} alt={alt} loading="lazy" className={cn('hidden dark:block', className)} />
      <Image {...rest} src={light} alt={alt} loading="lazy" className={cn('dark:hidden', className)} />
    </>
  );
}
