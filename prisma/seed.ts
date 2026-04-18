import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();

type TenantSeed = {
  fullName: string;
  unitNumber: string;
  bedrooms: number;
  monthlyRent: string;
};

const PROPERTIES: { name: string; address: string; tenants: TenantSeed[] }[] = [
  {
    name: "51 N Central LLC",
    address: "51 N Central Ave, Chicago, IL",
    tenants: [
      { fullName: "Sam Malone", unitNumber: "1A", bedrooms: 2, monthlyRent: "550.00" },
      { fullName: "David Young", unitNumber: "2A", bedrooms: 2, monthlyRent: "425.00" },
      { fullName: "Angela Bridges", unitNumber: "2B", bedrooms: 1, monthlyRent: "167.00" },
    ],
  },
  {
    name: "5304 W Chicago LLC",
    address: "5304 W Chicago Ave, Chicago, IL",
    tenants: [
      { fullName: "Victor Jones", unitNumber: "3A", bedrooms: 2, monthlyRent: "200.00" },
      { fullName: "Alex Livingston", unitNumber: "1B", bedrooms: 2, monthlyRent: "542.00" },
      { fullName: "Carla Moman", unitNumber: "4C", bedrooms: 3, monthlyRent: "1531.00" },
    ],
  },
];

async function main() {
  for (const p of PROPERTIES) {
    const property = await prisma.property.create({
      data: { name: p.name, address: p.address },
    });

    for (const t of p.tenants) {
      const unit = await prisma.unit.create({
        data: {
          propertyId: property.id,
          unitNumber: t.unitNumber,
          bedrooms: t.bedrooms,
        },
      });

      await prisma.tenant.create({
        data: {
          unitId: unit.id,
          fullName: t.fullName,
          monthlyRent: new Prisma.Decimal(t.monthlyRent),
          currentBalance: new Prisma.Decimal(t.monthlyRent),
        },
      });
    }
  }

  const count = await prisma.tenant.count();
  console.log(`Seed complete. Tenant count: ${count}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
