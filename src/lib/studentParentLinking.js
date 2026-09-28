// يوحّد صيغة أي رقم هاتف بغض النظر عن دولة صاحبه: يبقي على الأرقام فقط،
// ويزيل رمز الاتصال الدولي "00" إن وُجد في بداية الرقم (مثال: 00966501234567 → 966501234567).
// لا نفترض أي رمز دولة معيّن هنا، حتى لا تنكسر أرقام الدول غير السعودية.
export function normalizePhone(rawPhone) {
  if (rawPhone === null || rawPhone === undefined) return "";

  const digits = String(rawPhone).replace(/\D/g, "");
  if (!digits) return "";

  return digits.replace(/^00/, "");
}

// يقارن رقمين للتأكد أنهما لنفس الشخص، حتى لو اختلفت طريقة كتابتهما
// (مع/بدون رمز الدولة، مع/بدون صفر في البداية). المقارنة تتم على آخر 9 أرقام
// (وهو طول كافٍ لتمييز أي رقم جوال في أي دولة تقريبًا) بدل المطابقة الحرفية الكاملة.
export function phonesMatch(a, b) {
  const da = normalizePhone(a).replace(/^0+/, "");
  const db = normalizePhone(b).replace(/^0+/, "");
  if (!da || !db) return false;

  const shorter = da.length <= db.length ? da : db;
  const longer = da.length <= db.length ? db : da;

  return shorter.length >= 7 && longer.endsWith(shorter);
}

export async function findParentByPhone(supabase, rawPhone) {
  const phone = normalizePhone(rawPhone);
  if (!phone) return null;

  const core = phone.replace(/^0+/, "");
  const suffix = core.slice(-9);
  if (!suffix) return null;

  // نجلب كل الأرقام المنتهية بنفس آخر 9 أرقام من قاعدة البيانات مباشرة (بدل التحقق من صيغتين فقط)،
  // ثم نطابقها بدقّة في الكود لتفادي أي تطابق زائف.
  const { data, error } = await supabase
    .from("parents")
    .select("*")
    .ilike("phone", `%${suffix}`);

  if (error) throw error;
  if (!data || data.length === 0) return null;

  return data.find((p) => phonesMatch(p.phone, phone)) || null;
}

export async function createStudentWithParent({
  supabase,
  student,
  teacherId,
  parentPhone,
  parentName,
  username,
  password,
  existingParentId,
}) {
  const phone = normalizePhone(parentPhone);
  let parentId = existingParentId ?? null;

  if (!parentId) {
    const { data: userRow, error: userError } = await supabase
      .from("users")
      .insert({
        username,
        password,
        role: "parent",
        name: parentName,
      })
      .select()
      .single();

    if (userError) throw userError;

    const { error: parentError } = await supabase.from("parents").insert({
      id: userRow.id,
      name: parentName,
      phone,
    });

    if (parentError) throw parentError;
    parentId = userRow.id;
  }

  const { data: studentRow, error: studentError } = await supabase
    .from("students")
    .insert({
      name: student.name,
      age: Number(student.age) || 0,
      gender: student.gender || "male",
      level: student.level || "",
      next_lesson: student.nextLesson || "",
      behavior: student.behavior ?? 70,
      notes: student.notes || "",
      teacher_id: teacherId || null,
      parent_id: parentId,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (studentError) throw studentError;

  return {
    student: studentRow,
    parentId,
    createdParent: !existingParentId,
  };
}

export async function attachExistingParentToStudent({
  supabase,
  student,
  teacherId,
  parentId,
}) {
  const { data: studentRow, error: studentError } = await supabase
    .from("students")
    .insert({
      name: student.name,
      age: Number(student.age) || 0,
      gender: student.gender || "male",
      level: student.level || "",
      next_lesson: student.nextLesson || "",
      behavior: student.behavior ?? 70,
      notes: student.notes || "",
      teacher_id: teacherId || null,
      parent_id: parentId,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (studentError) throw studentError;
  return { student: studentRow, parentId };
}
