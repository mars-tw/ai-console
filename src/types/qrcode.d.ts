// qrcode 只用到 toDataURL 一個函式；自己宣告型別，不再多拉一個 @types 套件。
declare module 'qrcode' {
  export interface QRCodeToDataURLOptions {
    width?: number
    margin?: number
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
  }
  const QRCode: {
    toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>
  }
  export default QRCode
}
