/**
 * Uzbek administrative divisions used by the delivery flow.
 * Districts are the full official list; mahalla is typed by the customer
 * because there are ~10 000 of them and no stable public dataset.
 */
export interface Region {
  id: string;
  name: string;
  districts: string[];
}

export const REGIONS: Region[] = [
  {
    id: "tsh", name: "Toshkent shahri",
    districts: ["Bektemir", "Chilonzor", "Mirobod", "Mirzo Ulug'bek", "Olmazor", "Sergeli", "Shayxontohur", "Uchtepa", "Yakkasaroy", "Yashnobod", "Yunusobod"],
  },
  {
    id: "tvi", name: "Toshkent viloyati",
    districts: ["Bekobod", "Bo'ka", "Bo'stonliq", "Chinoz", "Qibray", "Ohangaron", "Oqqo'rg'on", "Parkent", "Piskent", "Quyi Chirchiq", "O'rta Chirchiq", "Yangiyo'l", "Yuqori Chirchiq", "Zangiota", "Nurafshon", "Chirchiq", "Angren", "Olmaliq"],
  },
  {
    id: "and", name: "Andijon",
    districts: ["Andijon sh.", "Asaka", "Baliqchi", "Bo'ston", "Buloqboshi", "Izboskan", "Jalaquduq", "Xo'jaobod", "Qo'rg'ontepa", "Marhamat", "Oltinko'l", "Paxtaobod", "Shahrixon", "Ulug'nor", "Xonabod"],
  },
  {
    id: "bux", name: "Buxoro",
    districts: ["Buxoro sh.", "Olot", "Buxoro tum.", "G'ijduvon", "Jondor", "Kogon", "Qorako'l", "Qorovulbozor", "Peshku", "Romitan", "Shofirkon", "Vobkent"],
  },
  {
    id: "fer", name: "Farg'ona",
    districts: ["Farg'ona sh.", "Marg'ilon", "Qo'qon", "Quvasoy", "Beshariq", "Bog'dod", "Buvayda", "Dang'ara", "Furqat", "Qo'shtepa", "Rishton", "So'x", "Toshloq", "Uchko'prik", "O'zbekiston", "Yozyovon", "Oltiariq", "Quva"],
  },
  {
    id: "jiz", name: "Jizzax",
    districts: ["Jizzax sh.", "Arnasoy", "Baxmal", "Do'stlik", "Forish", "G'allaorol", "Sharof Rashidov", "Mirzacho'l", "Paxtakor", "Yangiobod", "Zomin", "Zafarobod"],
  },
  {
    id: "xor", name: "Xorazm",
    districts: ["Urganch", "Xiva", "Bog'ot", "Gurlan", "Qo'shko'pir", "Shovot", "Urganch tum.", "Xonqa", "Yangiariq", "Yangibozor", "Hazorasp", "Tuproqqal'a"],
  },
  {
    id: "nam", name: "Namangan",
    districts: ["Namangan sh.", "Chortoq", "Chust", "Kosonsoy", "Mingbuloq", "Namangan tum.", "Norin", "Pop", "To'raqo'rg'on", "Uychi", "Uchqo'rg'on", "Yangiqo'rg'on"],
  },
  {
    id: "nav", name: "Navoiy",
    districts: ["Navoiy sh.", "Zarafshon", "G'azg'on", "Karmana", "Konimex", "Qiziltepa", "Xatirchi", "Navbahor", "Nurota", "Tomdi", "Uchquduq"],
  },
  {
    id: "qas", name: "Qashqadaryo",
    districts: ["Qarshi", "Shahrisabz", "Chiroqchi", "Dehqonobod", "G'uzor", "Kasbi", "Kitob", "Koson", "Mirishkor", "Muborak", "Nishon", "Qamashi", "Yakkabog'"],
  },
  {
    id: "qrq", name: "Qoraqalpog'iston",
    districts: ["Nukus", "Amudaryo", "Beruniy", "Chimboy", "Ellikqal'a", "Kegeyli", "Mo'ynoq", "Nukus tum.", "Qanliko'l", "Qo'ng'irot", "Qorao'zak", "Shumanay", "Taxtako'pir", "To'rtko'l", "Xo'jayli"],
  },
  {
    id: "sam", name: "Samarqand",
    districts: ["Samarqand sh.", "Bulung'ur", "Ishtixon", "Jomboy", "Kattaqo'rg'on", "Qo'shrabot", "Narpay", "Nurobod", "Oqdaryo", "Passdarg'om", "Paxtachi", "Payariq", "Samarqand tum.", "Toyloq", "Urgut"],
  },
  {
    id: "sir", name: "Sirdaryo",
    districts: ["Guliston", "Shirin", "Yangiyer", "Boyovut", "Guliston tum.", "Xovos", "Mirzaobod", "Oqoltin", "Sardoba", "Sayxunobod", "Sirdaryo"],
  },
  {
    id: "sur", name: "Surxondaryo",
    districts: ["Termiz", "Angor", "Bandixon", "Boysun", "Denov", "Jarqo'rg'on", "Qiziriq", "Qumqo'rg'on", "Muzrabot", "Oltinsoy", "Sariosiyo", "Sherobod", "Sho'rchi", "Termiz tum.", "Uzun"],
  },
];

export function regionById(id: string): Region | undefined {
  return REGIONS.find((r) => r.id === id);
}
