import { emoji } from "./emoji/map.js";

export const reactionChoices = [...new Map(Object.entries(emoji).map(([name, filename]) => {
  const number = Number(filename.match(/\d+/)?.[0]);
  const image = `https://tb2.bdstatic.com/tb/editor/images/client/image_emoticon${number}.png`;
  return [image, { name, image, filename }];
})).values()];

export function isCatalogReaction(image) {
  return reactionChoices.some((choice) => choice.image === image);
}
