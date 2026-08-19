// 像素精靈：用 box-shadow 畫點陣圖
// 圖例：字元 → 顏色 key（傳入 palette）

export const HUMAN_SPRITE = [
  '....HHHH....',
  '...HHHHHH...',
  '...HSSSSH...',
  '...SESSKS...',
  '...SSSSSS...',
  '....SSSS....',
  '...BBBBBB...',
  '..SBBBBBBS..',
  '..SBBBBBBS..',
  '..SBBBBBBS..',
  '...BBBBBB...',
  '...PP..PP...',
  '...PP..PP...',
  '...FF..FF...',
]

// 傻傻流口水大眼睛小黃龍
export const DRAGON_SPRITE = [
  '..........',
  '.WW....WW.',
  '.YYY..YYY.',
  'YYYYYYYYYY',
  'YWYWWYWYY.',
  'YEYEEYEYY.',
  'YYYYYYYYYY',
  'YYMMMMD...',
  '.YYYYYD...',
  '..YYYD....',
  '..Y..Y....',
  '..Y..Y....',
]

export const PALETTES = {
  humanBase: {
    S: '#f2c894', // 皮膚
    E: '#ffffff', // 眼白
    K: '#18181b', // 瞳孔/深色
    H: '#3f3f46', // 頭髮（可被工具色覆蓋）
    B: '#71717a', // 衣服（工具主色）
    P: '#3f3f46', // 褲子
    F: '#27272a', // 鞋
  },
  dragon: {
    Y: '#fbbf24', // 黃龍身體
    W: '#fef08a', // 角/肚皮淺黃
    E: '#ffffff', // 大眼白
    K: '#18181b',
    M: '#be123c', // 嘴巴
    D: '#7dd3fc', // 口水
  },
}

interface Props {
  map: string[]
  palette: Record<string, string>
  px?: number
  className?: string
}

export default function PixelSprite({ map, palette, px = 4, className }: Props) {
  const shadows: string[] = []
  map.forEach((row, y) => {
    row.split('').forEach((ch, x) => {
      const color = palette[ch]
      if (color) shadows.push(`${(x + 1) * px}px ${(y + 1) * px}px 0 0 ${color}`)
    })
  })
  return (
    <div
      className={className}
      style={{
        width: map[0].length * px,
        height: map.length * px,
        position: 'relative',
        imageRendering: 'pixelated',
      }}
    >
      <div
        style={{
          position: 'absolute',
          width: px,
          height: px,
          boxShadow: shadows.join(','),
        }}
      />
    </div>
  )
}
