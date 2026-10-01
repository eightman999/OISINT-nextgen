import type { ImageSourcePropType } from 'react-native';

import type { RestaurantImageKey } from './restaurantImages';

// Metro requires literal asset paths. Keeping the platform-specific imports in
// one module also lets component tests replace this boundary without parsing
// JPEG bytes as JavaScript.
export const RESTAURANT_IMAGE_SOURCES: Record<
  RestaurantImageKey,
  ImageSourcePropType
> = {
  'demo-yakiniku-v1.jpg': require('../../assets/demo/restaurants/demo-yakiniku-v1.jpg'),
  'demo-izakaya-v1.jpg': require('../../assets/demo/restaurants/demo-izakaya-v1.jpg'),
  'demo-steak-v1.jpg': require('../../assets/demo/restaurants/demo-steak-v1.jpg'),
  'demo-sushi-v1.jpg': require('../../assets/demo/restaurants/demo-sushi-v1.jpg'),
  'demo-cafe-v1.jpg': require('../../assets/demo/restaurants/demo-cafe-v1.jpg'),
  'demo-ramen-v1.jpg': require('../../assets/demo/restaurants/demo-ramen-v1.jpg'),
  'demo-italian-v1.jpg': require('../../assets/demo/restaurants/demo-italian-v1.jpg'),
  'demo-washoku-v1.jpg': require('../../assets/demo/restaurants/demo-washoku-v1.jpg'),
  'demo-chinese-v1.jpg': require('../../assets/demo/restaurants/demo-chinese-v1.jpg'),
  'demo-bistro-v1.jpg': require('../../assets/demo/restaurants/demo-bistro-v1.jpg'),
  'demo-yakitori-v1.jpg': require('../../assets/demo/restaurants/demo-yakitori-v1.jpg'),
  'demo-tempura-v1.jpg': require('../../assets/demo/restaurants/demo-tempura-v1.jpg'),
  'demo-soba-v1.jpg': require('../../assets/demo/restaurants/demo-soba-v1.jpg'),
  'demo-udon-v1.jpg': require('../../assets/demo/restaurants/demo-udon-v1.jpg'),
  'demo-curry-v1.jpg': require('../../assets/demo/restaurants/demo-curry-v1.jpg'),
  'demo-korean-v1.jpg': require('../../assets/demo/restaurants/demo-korean-v1.jpg'),
  'demo-spanish-v1.jpg': require('../../assets/demo/restaurants/demo-spanish-v1.jpg'),
  'demo-seafood-v1.jpg': require('../../assets/demo/restaurants/demo-seafood-v1.jpg'),
  'demo-vegan-v1.jpg': require('../../assets/demo/restaurants/demo-vegan-v1.jpg'),
  'demo-bakery-v1.jpg': require('../../assets/demo/restaurants/demo-bakery-v1.jpg'),
};
